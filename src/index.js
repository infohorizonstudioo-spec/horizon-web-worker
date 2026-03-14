import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import crypto from "crypto";
import os from "os";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.OWNER_TELEGRAM_CHAT_ID;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const POLL_MS = parseInt(process.env.POLLING_INTERVAL_MS || "8000");
const MY_TYPES = ["web_generate", "web_deploy"];
const MY_ROLES = ["frontend", "worker"];

function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] [WEB] ${msg}`); }

async function tg(text, chatId) {
  const target = chatId || CHAT;
  if (!BOT || !target) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: target, text: String(text).slice(0, 4096) })
    });
  } catch {}
}

// Genera los archivos del proyecto Next.js usando Claude
async function generateNextJsProject(task) {
  const brief = task.input_prompt || task.input_json?.prompt || "Crea una web profesional";
  log("Generando componentes Next.js con Sonnet...");

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    messages: [{ role: "user", content: `Eres un experto en Next.js 14 y Tailwind CSS. Genera los archivos de un proyecto web completo y profesional.

BRIEFING:
${brief}

REGLAS:
- Usa Next.js 14 App Router
- Tailwind CSS para todos los estilos
- Componentes reutilizables en /components
- Diseño moderno, premium, mobile-first
- Fotos reales de Unsplash directamente en los src
- Google Fonts via next/font
- SEO completo con metadata en layout.tsx
- Sin TypeScript errors (usa tipos correctos)
- Sin dependencias externas salvo las incluidas en el package.json base

Devuelve SOLO un JSON con esta estructura exacta (sin markdown, sin texto extra):
{
  "page_title": "titulo",
  "files": {
    "app/page.tsx": "contenido completo del archivo",
    "app/layout.tsx": "contenido completo del archivo",
    "components/Hero.tsx": "contenido completo",
    "components/Features.tsx": "contenido completo",
    "components/Contact.tsx": "contenido completo",
    "components/Footer.tsx": "contenido completo"
  }
}` }]
  });

  const raw = (msg.content[0]?.text || "").trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  const i = raw.indexOf("{"); const e = raw.lastIndexOf("}");
  if (i === -1) throw new Error("Claude no devolvio JSON valido");
  return JSON.parse(raw.slice(i, e + 1));
}

// Construye el proyecto Next.js y devuelve el directorio out/
async function buildNextProject(projectFiles, projectName) {
  const tmpDir = join(os.tmpdir(), "horizon-" + projectName);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  mkdirSync(tmpDir, { recursive: true });
  log(`Build dir: ${tmpDir}`);

  // package.json base
  writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
    name: projectName, version: "1.0.0", private: true,
    scripts: { build: "next build", dev: "next dev" },
    dependencies: {
      next: "14.2.3", react: "^18", "react-dom": "^18"
    },
    devDependencies: {
      tailwindcss: "^3.4", autoprefixer: "^10", postcss: "^8",
      "@types/node": "^20", "@types/react": "^18", "@types/react-dom": "^18",
      typescript: "^5"
    }
  }, null, 2));

  // next.config.js — output: export para subir a Cloudflare Pages
  writeFileSync(join(tmpDir, "next.config.js"), `/** @type {import('next').NextConfig} */
const nextConfig = { output: 'export', images: { unoptimized: true }, trailingSlash: true };
module.exports = nextConfig;`);

  // tailwind.config.js
  writeFileSync(join(tmpDir, "tailwind.config.js"), `/** @type {import('tailwindcss').Config} */
module.exports = { content: ['./app/**/*.{js,ts,jsx,tsx}','./components/**/*.{js,ts,jsx,tsx}'], theme: { extend: {} }, plugins: [] };`);

  // postcss.config.js
  writeFileSync(join(tmpDir, "postcss.config.js"), `module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };`);

  // tsconfig.json
  writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "es5", lib: ["dom","dom.iterable","esnext"], allowJs: true, skipLibCheck: true,
      strict: true, noEmit: true, esModuleInterop: true, module: "esnext", moduleResolution: "bundler",
      resolveJsonModule: true, isolatedModules: true, jsx: "preserve", incremental: true,
      plugins: [{ name: "next" }], paths: { "@/*": ["./*"] } },
    include: ["next-env.d.ts","**/*.ts","**/*.tsx",".next/types/**/*.ts"],
    exclude: ["node_modules"]
  }, null, 2));

  // globals.css
  mkdirSync(join(tmpDir, "app"), { recursive: true });
  writeFileSync(join(tmpDir, "app", "globals.css"), `@tailwind base;\n@tailwind components;\n@tailwind utilities;`);

  // components dir
  mkdirSync(join(tmpDir, "components"), { recursive: true });

  // Escribir archivos generados por Claude
  for (const [filePath, content] of Object.entries(projectFiles)) {
    const fullPath = join(tmpDir, filePath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
    log(`Escrito: ${filePath} (${content.length} chars)`);
  }

  // npm install + next build
  log("Instalando dependencias...");
  execSync("npm install --prefer-offline --no-audit --no-fund", { cwd: tmpDir, stdio: "pipe", timeout: 120000 });
  log("Construyendo...");
  execSync("npm run build", { cwd: tmpDir, stdio: "pipe", timeout: 180000, env: { ...process.env, NODE_ENV: "production" } });

  const outDir = join(tmpDir, "out");
  log(`Build completado. out/ generado.`);
  return { outDir, tmpDir };
}

// Sube todos los archivos del directorio out/ a Cloudflare Pages
async function deployToCloudflare(projectName, outDir) {
  // 1. Crear proyecto Pages
  const r1 = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/pages/projects`, {
    method: "POST", headers: { "Authorization": `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: projectName, production_branch: "main" })
  });
  const d1 = await r1.json();
  if (!r1.ok && !JSON.stringify(d1).includes("8000007")) log(`Pages project warn: ${JSON.stringify(d1.errors)}`);

  // 2. Recoger todos los archivos del out/
  function getAllFiles(dir, base = dir) {
    const files = [];
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (statSync(full).isDirectory()) { files.push(...getAllFiles(full, base)); }
      else { files.push({ full, rel: "/" + relative(base, full).replace(/\\/g, "/") }); }
    }
    return files;
  }
  const files = getAllFiles(outDir);
  log(`Subiendo ${files.length} archivos a Cloudflare Pages...`);

  // 3. Direct Upload — crear deployment
  const form1 = new FormData();
  form1.append("branch", "main");
  const r2 = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/pages/projects/${projectName}/deployments`, {
    method: "POST", headers: { "Authorization": `Bearer ${CF_TOKEN}` }, body: form1
  });
  const d2 = await r2.json();

  // 4. Upload files via bulk upload
  const manifest = {};
  const formFiles = new FormData();
  for (const { full, rel } of files) {
    const content = readFileSync(full);
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    manifest[rel] = hash;
    const mimeType = rel.endsWith(".html") ? "text/html" : rel.endsWith(".css") ? "text/css" :
      rel.endsWith(".js") ? "application/javascript" : rel.endsWith(".json") ? "application/json" :
      rel.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
    formFiles.append(`files[${hash}]`, new Blob([content], { type: mimeType }), rel.slice(1));
  }
  formFiles.append("manifest", JSON.stringify(manifest));

  const r3 = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/pages/projects/${projectName}/deployments`, {
    method: "POST", headers: { "Authorization": `Bearer ${CF_TOKEN}` }, body: formFiles
  });
  const d3 = await r3.json();
  if (!r3.ok) throw new Error("Deploy failed: " + JSON.stringify(d3.errors));

  const url = d3.result?.url || `https://${projectName}.pages.dev`;
  log(`Desplegado: ${url}`);
  return url;
}

async function claimTask() {
  try {
    const { data: tasks } = await supabase.from("agent_tasks").select("*")
      .eq("status", "pending").order("sequence_order", { ascending: true }).limit(20);
    if (!tasks?.length) return null;
    for (const task of tasks) {
      const execType = task.input_json?.execution_type || task.input_json?.task_type || task.task_type || "";
      const isWebTask = MY_TYPES.some(t => execType.includes(t)) || MY_ROLES.includes(task.agent_role);
      if (!isWebTask) continue;
      if (task.depends_on?.length) {
        const { data: deps } = await supabase.from("agent_tasks").select("id,status").in("id", task.depends_on);
        if (!deps?.every(d => d.status === "done" || d.status === "skipped")) continue;
      }
      const { data: claimed, error } = await supabase.from("agent_tasks")
        .update({ status: "running", started_at: new Date().toISOString() })
        .eq("id", task.id).eq("status", "pending").select().single();
      if (!error && claimed) return claimed;
    }
    return null;
  } catch (e) { log("claimTask: " + e.message); return null; }
}

async function completeTask(taskId, woId, success, url, error) {
  await supabase.from("agent_tasks").update({
    status: success ? "done" : "failed",
    output_json: { url: url || null, worker: "web-worker", framework: "nextjs" },
    error_message: error || null, completed_at: new Date().toISOString()
  }).eq("id", taskId);
  await supabase.from("agent_events").insert({
    work_order_id: woId, agent_name: "web-worker",
    event_type: success ? "web_deployed" : "web_failed",
    message: success ? `Next.js web publicada: ${url}` : `Error: ${error}`,
    payload_json: { url, framework: "nextjs" }
  });
  try { await supabase.rpc("update_work_order_progress", { p_work_order_id: woId }); } catch {}
}

async function processTask() {
  const task = await claimTask();
  if (!task) return false;
  const chatId = task.input_json?.chat_id || task.input_json?.telegram_chat_id || CHAT;
  log(`Procesando: ${task.title}`);

  const projectName = ("horizon-" + Date.now().toString(36)).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
  let tmpDir = null;

  try {
    // 1. Generar archivos Next.js con Claude
    const result = await generateNextJsProject(task);
    log(`Archivos generados: ${Object.keys(result.files).join(", ")}`);

    // 2. Build
    const built = await buildNextProject(result.files, projectName);
    tmpDir = built.tmpDir;

    // 3. Deploy
    const url = await deployToCloudflare(projectName, built.outDir);

    // 4. Guardar + notificar
    await completeTask(task.id, task.work_order_id, true, url, null);
    await supabase.from("work_orders").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", task.work_order_id);
    await tg(`Aqui tienes la web:\n\n${url}`, chatId);
    log(`Completado: ${url}`);
  } catch (err) {
    log("Error: " + err.message);
    await completeTask(task.id, task.work_order_id, false, null, err.message.slice(0, 300));
    await tg(`Algo fallo generando la web. Error: ${err.message.slice(0, 150)}`, chatId);
  } finally {
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  }
  return true;
}

async function heartbeat() {
  try { await supabase.from("worker_health").upsert({ worker_name: "horizon-web-worker", status: "online", heartbeat_at: new Date().toISOString() }, { onConflict: "worker_name" }); } catch {}
}

async function main() {
  log("Horizon Web Worker (Next.js) activo");
  await heartbeat();
  setInterval(heartbeat, 60000);
  while (true) {
    try { const did = await processTask(); if (did) continue; } catch (e) { log("Loop: " + e.message); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("uncaughtException", e => log("Uncaught: " + e.message));
main();
