#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { shadowReport } from "../src/jevShadowReport.mjs";
const [file, day] = process.argv.slice(2);
if (!file || !day) throw new Error("Usage: report-jev-shadow.mjs <database-file> <Bangkok YYYY-MM-DD>");
const db = new DatabaseSync(file, { readOnly: true });
try { console.log(JSON.stringify(shadowReport(db, day), null, 2)); }
finally { db.close(); }
