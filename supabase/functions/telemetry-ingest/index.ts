// ==============================================================================
// Edge Function: telemetry-ingest
// Description: High-throughput batched ingestion into partitioned audit logs
// Runtime: Supabase Edge Runtime (Deno / TypeScript)
// ==============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

interface TelemetryBatchEvent {
  org_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
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

    const body = await req.json();
    const events: TelemetryBatchEvent[] = Array.isArray(body) ? body : [body];

    if (events.length === 0) {
      return new Response(JSON.stringify({ error: "Empty event batch" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const client = createClient(supabaseUrl, supabaseServiceKey);

    const clientIp = req.headers.get("x-forwarded-for") || "127.0.0.1";
    const userAgent = req.headers.get("user-agent") || "unknown";

    const rowsToInsert = events.map((ev) => ({
      org_id: ev.org_id,
      action: ev.action,
      resource_type: ev.resource_type,
      resource_id: ev.resource_id,
      ip_address: clientIp.split(",")[0]?.trim(),
      user_agent: userAgent,
      metadata: ev.metadata || {},
      created_at: ev.timestamp || new Date().toISOString(),
    }));

    // Schema: telemetry, Table: audit_events
    const { error: insertError } = await client
      .schema("telemetry")
      .from("audit_events")
      .insert(rowsToInsert);

    if (insertError) {
      return new Response(
        JSON.stringify({ error: insertError.message, details: "Batch ingestion failed" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        ingested_count: events.length,
        partition_target: "telemetry.audit_events",
      }),
      { status: 202, headers: { "Content-Type": "application/json" } }
    );
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Internal Server Error";
    return new Response(JSON.stringify({ error: errorMsg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
