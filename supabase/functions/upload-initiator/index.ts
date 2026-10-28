// ==============================================================================
// Edge Function: upload-initiator
// Description: Multi-tenant multipart upload initiator & presigned session generator
// Runtime: Supabase Edge Runtime (Deno / TypeScript)
// ==============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

interface InitiateUploadRequest {
  org_id: string;
  vault_id: string;
  object_key: string;
  expected_size_bytes: number;
  part_size_bytes?: number;
  content_type?: string;
  metadata?: Record<string, unknown>;
}

const DEFAULT_PART_SIZE = 5 * 1024 * 1024; // 5 MiB minimum chunk size

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

    const payload: InitiateUploadRequest = await req.json();
    const { org_id, vault_id, object_key, expected_size_bytes } = payload;

    if (!org_id || !vault_id || !object_key || !expected_size_bytes) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: org_id, vault_id, object_key, expected_size_bytes" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const partSize = payload.part_size_bytes || DEFAULT_PART_SIZE;
    const totalParts = Math.ceil(expected_size_bytes / partSize);
    const uploadId = `upl_${crypto.randomUUID().replace(/-/g, "")}`;

    // Initialize Supabase Client with Caller's JWT to enforce RLS
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const client = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // 1. Insert multipart upload session record (will trigger fn_check_storage_quota)
    const { data: uploadSession, error: dbError } = await client
      .from("object_multipart_uploads")
      .insert({
        org_id,
        vault_id,
        object_key,
        upload_id: uploadId,
        expected_size_bytes,
        part_size_bytes: partSize,
        total_parts: totalParts,
        status: "initiated",
      })
      .select()
      .single();

    if (dbError) {
      const status = dbError.code === "54000" ? 413 : 403;
      return new Response(
        JSON.stringify({
          error: dbError.message,
          code: dbError.code,
          details: "Failed to initiate multipart upload session",
        }),
        { status, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Generate deterministic S3-compatible chunk upload descriptors
    const partsManifest = Array.from({ length: totalParts }, (_, i) => {
      const partNumber = i + 1;
      const startByte = i * partSize;
      const endByte = Math.min((i + 1) * partSize - 1, expected_size_bytes - 1);
      const chunkSize = endByte - startByte + 1;

      return {
        part_number: partNumber,
        expected_chunk_size_bytes: chunkSize,
        start_byte: startByte,
        end_byte: endByte,
        upload_endpoint: `${supabaseUrl}/functions/v1/chunk-completer`,
      };
    });

    return new Response(
      JSON.stringify({
        success: true,
        upload_id: uploadId,
        session: uploadSession,
        part_size_bytes: partSize,
        total_parts: totalParts,
        manifest: partsManifest,
      }),
      {
        status: 201,
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
