import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import { z } from "zod";

const databaseUrl = process.env.OPENFANG_SUPABASE_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("OPENFANG_SUPABASE_DATABASE_URL is required");
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});

const server = new McpServer({
  name: "openfang-supabase-admin",
  version: "1.0.0",
});

function textResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

server.registerTool(
  "inspect_schema",
  {
    description:
      "Inspect tables, columns, and RLS status. Use this before writing migrations or policies.",
    inputSchema: {
      schema: z.string().min(1).default("public"),
    },
  },
  async ({ schema }) => {
    const result = await pool.query(
      `SELECT c.relname AS table_name,
              c.relrowsecurity AS rls_enabled,
              c.relforcerowsecurity AS rls_forced,
              COALESCE(
                json_agg(
                  json_build_object(
                    'name', a.attname,
                    'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
                    'nullable', NOT a.attnotnull
                  ) ORDER BY a.attnum
                ) FILTER (WHERE a.attnum > 0 AND NOT a.attisdropped),
                '[]'::json
              ) AS columns
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = $1
          AND c.relkind IN ('r', 'p', 'v', 'm')
        GROUP BY c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
        ORDER BY c.relname`,
      [schema],
    );

    return textResult({ schema, relations: result.rows });
  },
);

server.registerTool(
  "execute_sql",
  {
    description:
      "Execute administrative SQL against the self-hosted Supabase PostgreSQL database. Use only after explaining the change and obtaining explicit user confirmation for destructive operations. Never return secrets or sensitive user data.",
    inputSchema: {
      sql: z.string().min(1).max(100_000),
    },
  },
  async ({ sql }) => {
    const result = await pool.query(sql);
    return textResult({
      command: result.command,
      rowCount: result.rowCount,
      rows: result.rows.slice(0, 100),
      truncated: result.rows.length > 100,
    });
  },
);

await server.connect(new StdioServerTransport());
