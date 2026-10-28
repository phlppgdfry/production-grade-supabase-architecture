// ==============================================================================
// Edge Function: chunk-completer
// Description: Receives, validates checksum digests, and commits chunk parts
// Runtime: Supabase Edge Runtime (Deno / TypeScript)
// ==============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

interface ChunkCompletionRequest {
  upload_id: string;
  part_number: number;
  size_bytes: number;
  checksum_sha256: string;
  etag: string;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const payload: ChunkCompletionRequest = await req.json();
    const { upload_id, part_number, size_bytes, checksum_sha256, etag } = payload;

    if (!upload_id || !part_number || !size_bytes || !checksum_sha256 || !etag) {
      return new Response(
        JSON.stringify({ error: "Missing required chunk fields: upload_id, part_number, size_bytes, checksum_sha256, etag" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const client = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // 1. Insert chunk record into object_parts
    // (This triggers trg_verify_part_and_transition in PostgreSQL)
    const { data: partRecord, error: partError } = await client
      .from("object_parts")
      .insert({
        upload_id,
        part_number,
        size_bytes,
        checksum_sha256,
        etag,
      })
      .select()
      .single();

    if (partError) {
      return new Response(
        JSON.stringify({
          error: partError.message,
          code: partError.code,
          details: "Chunk integrity or permission validation failed",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Query updated upload status
    const { data: uploadStatus } = await client
      .from("object_multipart_uploads")
      .select("status, total_parts, expected_size_bytes")
      .eq("upload_id", upload_id)
      .single();

    return new Response(
      JSON.stringify({
        success: true,
        part: partRecord,
        upload_status: uploadStatus?.status,
        is_assembled: uploadStatus?.status === "assembling",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Internal Server Error";
    return new Response(JSON.stringify({ error: errorMsg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
