import { readFileSync } from "fs";
import { createClient } from "@libsql/client";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf-8");
const statements = schema.split(";").map((s) => s.trim()).filter(Boolean);

for (const stmt of statements) {
  await client.execute(stmt);
  console.log("OK:", stmt.slice(0, 50).replace(/\n/g, " "), "...");
}

console.log("База готова.");
