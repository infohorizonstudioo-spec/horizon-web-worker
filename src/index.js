import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, existsSync } from "fs";
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
const SITES_DIR = process.env.SITES_DIR || join(os.tmpdir(), "generated-sites");

// Task types this worker handles
const HANDLED_TYPES = [
  "web_generate", "web_deploy",
  "assemble_nextjs_project", "deploy_preview", "notify_telegram",
  "collect_website_assets", "generate_website_brief",
  "generate_website_structure", "generate_homepage_copy",
  "generate_seo_metadata", "process_images"
];

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

// ── PHASE 3: Generate real Next.js project files ──────────────────────────

async function generateNextJsFiles(brief, photoUrls, projectSlug) {
  const photos = (photoUrls || []).filter(Boolean);
  const photoSection = photos.length > 0
    ? `\nFOTOS REALES DEL CLIENTE (usa estas URLs directamente en los img src):\n${photos.map((u,i) => `Foto ${i+1}: ${u}`).join("\n")}`
    : "\nSin fotos — usa imagenes de Unsplash con URLs directas (photo-XXXX?w=1200&q=80).";

  const prompt = `Eres un experto en Next.js 14 y Tailwind CSS. Crea una landing page profesional completa.

BRIEFING:
${brief}
${photoSection}

REGLAS ESTRICTAS:
- Todo el codigo de la pagina en app/page.tsx (un solo archivo)
- Empieza con "use client";
- NO importes componentes externos (todo inline en page.tsx)
- NO uses next/image — usa <img> normal con URLs directas
- Tailwind CSS para todos los estilos
- Diseño moderno, premium, responsive, mobile-first
- Animaciones suaves con CSS transitions
- Secciones: hero, servicios/caracteristicas, galeria (si hay fotos), contacto, footer
- Incluye numero de telefono y email en el contacto si estan en el briefing
- SEO: export const metadata con title y description

DEVUELVE SOLO JSON VALIDO (sin markdown, sin texto antes/despues):
{
  "project_title": "titulo corto",
  "description": "descripcion 1 frase",
  "files": {
    "app/page.tsx": "CODIGO TSX COMPLETO",
    "app/layout.tsx": "LAYOUT COMPLETO"
  }
}`;

  log("Llamando a Claude Sonnet para generar Next.js...");
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }]
  });

  const raw = (msg.content[0]?.text || "")
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  const i = raw.indexOf("{"); const e = raw.lastIndexOf("}");
  if (i === -1) throw new Error("Claude no devolvio JSON: " + raw.slice(0, 200));
  return JSON.parse(raw.slice(i, e + 1));
}

function writeProjectFiles(projectSlug, generatedFiles) {
  const projectDir = join(SITES_DIR, projectSlug);
  mkdirSync(join(projectDir, "app"), { recursive: true });
  mkdirSync(join(projectDir, "public"), { recursive: true });
  mkdirSync(join(projectDir, "components"), { recursive: true });

  // Archivos de configuracion base
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({
    name: projectSlug, version: "1.0.0", private: true,
    scripts: { build: "next build", dev: "next dev", start: "next start" },
    dependencies: {
      next: "14.2.3", react: "^18", "react-dom": "^18",
      tailwindcss: "^3.4", autoprefixer: "^10", postcss: "^8",
      "@types/node": "^20", "@types/react": "^18", "@types/react-dom": "^18", typescript: "^5"
    }
  }, null, 2));

  writeFileSync(join(projectDir, "next.config.js"),
    "const c={output:'export',images:{unoptimized:true},trailingSlash:true};module.exports=c;");

  writeFileSync(join(projectDir, "tailwind.config.js"),
    "module.exports={content:['./app/**/*.{js,ts,jsx,tsx}','./components/**/*.{js,ts,jsx,tsx}'],theme:{extend:{}},plugins:[]};");

  writeFileSync(join(projectDir, "postcss.config.js"),
    "module.exports={plugins:{tailwindcss:{},autoprefixer:{}}};");

  writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "es5", lib: ["dom", "dom.iterable", "esnext"], allowJs: true,
      skipLibCheck: true, strict: false, noEmit: true, esModuleInterop: true,
      module: "esnext", moduleResolution: "bundler", resolveJsonModule: true,
      isolatedModules: true, jsx: "preserve", incremental: true,
      baseUrl: ".", paths: { "@/*": ["./*"] }
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"], exclude: ["node_modules"]
  }, null, 2));

  writeFileSync(join(projectDir, "app", "globals.css"),
    "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n");

  // Archivos generados por Claude
  for (const [filePath, content] of Object.entries(generatedFiles)) {
    const fullPath = join(projectDir, filePath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
    log(`Escrito: ${filePath} (${content.length} chars)`);
  }

  return projectDir;
}

// ── PHASE 4 (when needed): Build + Deploy ────────────────────────────────

function buildProject(projectDir) {
  log("npm install...");
  execSync("npm install --no-audit --no-fund", { cwd: projectDir, stdio: "pipe", timeout: 180000 });
  log("next build...");
  try {
    execSync("npm run build", {
      cwd: projectDir, stdio: "pipe", timeout: 300000,
      env: { ...process.env, NODE_ENV: "production" }
    });
  } catch (e) {
    const stderr = e.stderr?.toString() || "";
    throw new Error("Build failed: " + stderr.slice(0, 400));
  }
  return join(projectDir, "out");
}

function getAllFiles(dir, base = dir) {
  const files = [];
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    if (statSync(full).isDirectory()) files.push(...getAllFiles(full, base));
    else files.push({ full, rel: "/" + relative(base, full).replace(/\\/g, "/") });
  }
  return files;
}

async function deployToCloudflare(projectName, outDir) {
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/pages/projects`, {
    method: "POST", headers: { "Authorization": `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: projectName, production_branch: "main" })
  });

  const files = getAllFiles(outDir);
  log(`Subiendo ${files.length} archivos a Cloudflare...`);

  const manifest = {};
  const form = new FormData();
  for (const { full, rel } of files) {
    const buf = readFileSync(full);
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    manifest[rel] = hash;
    const mime = rel.endsWith(".html") ? "text/html" : rel.endsWith(".css") ? "text/css" :
      rel.endsWith(".js") ? "application/javascript" : rel.endsWith(".json") ? "application/json" :
      "application/octet-stream";
    form.append(`files[${hash}]`, new Blob([buf], { type: mime }), rel.slice(1));
  }
  form.append("manifest", JSON.stringify(manifest));

  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/pages/projects/${projectName}/deployments`,
    { method: "POST", headers: { "Authorization": `Bearer ${CF_TOKEN}` }, body: form }
  );
  const d = await r.json();
  if (!r.ok) throw new Error("Deploy failed: " + JSON.stringify(d.errors));
  return d.result?.url || `https://${projectName}.pages.dev`;
}

// ── TASK ROUTING ─────────────────────────────────────────────────────────

async function handleTask(task) {
  const type = task.task_type || task.input_json?.task_type || "";
  const input = task.input_json || {};
  const brief = task.input_prompt || input.prompt || input.brief || "";
  const chatId = input.chat_id || CHAT;
  const workOrderId = task.work_order_id;

  // Tareas de relleno (Phase 2 graph — las ejecutamos como no-op para avanzar el grafo)
  const PASSTHROUGH = ["collect_website_assets","generate_website_brief",
    "generate_website_structure","generate_homepage_copy","generate_seo_metadata","process_images"];
  if (PASSTHROUGH.includes(type)) {
    log(`Pasando: ${type}`);
    await supabase.from("agent_tasks").update({
      status: "done", output_json: { skipped: false, phase: "passthrough", task_type: type },
      completed_at: new Date().toISOString()
    }).eq("id", task.id);
    return true;
  }

  // ── PHASE 3: Generar archivos Next.js reales ──
  if (type === "assemble_nextjs_project" || type === "web_generate") {
    const photoUrls = input.photo_urls || [];
    const projectSlug = ("horizon-" + Date.now().toString(36)).toLowerCase();

    // ── PHASE 5: Milestone 3 — Generación iniciada ──
    await tg("Generando tu web ahora con Next.js + Tailwind. Esto tarda unos minutos, te aviso cuando este lista.", chatId);
    await supabase.from("agent_events").insert({
      work_order_id: workOrderId, actor: "web-worker",
      event_type: "telegram_notification_sent",
      message: "Generando tu web ahora...",
      payload_json: { milestone: "generation_started", chat_id: chatId },
      created_at: new Date().toISOString()
    });

    log(`Generando proyecto Next.js: ${projectSlug}`);
    const generated = await generateNextJsFiles(brief, photoUrls, projectSlug);
    log(`Archivos Claude: ${Object.keys(generated.files).join(", ")}`);

    const projectDir = writeProjectFiles(projectSlug, generated.files);
    const fileList = Object.keys(generated.files);
    log(`Proyecto escrito en: ${projectDir}`);

    // Guardar en BD — output_json con ruta y archivos
    await supabase.from("agent_tasks").update({
      status: "done",
      output_json: {
        project_slug: projectSlug,
        project_dir: projectDir,
        project_title: generated.project_title || "",
        description: generated.description || "",
        files_generated: fileList,
        file_count: fileList.length,
        ready_for_build: true
      },
      completed_at: new Date().toISOString()
    }).eq("id", task.id);

    // Guardar también en work_order metadata
    await supabase.from("work_orders").update({
      metadata: { ...(await getWoMetadata(workOrderId)), project_slug: projectSlug, project_dir: projectDir, files_generated: fileList },
      updated_at: new Date().toISOString()
    }).eq("id", workOrderId);

    // Evento en agent_events
    await supabase.from("agent_events").insert({
      work_order_id: workOrderId, actor: "web-worker",
      event_type: "nextjs_files_generated",
      message: `Proyecto ${projectSlug} generado. ${fileList.length} archivos: ${fileList.join(", ")}`,
      payload_json: { project_slug: projectSlug, project_dir: projectDir, files: fileList },
      created_at: new Date().toISOString()
    });

    log(`Phase 3 completa: ${projectSlug}`);
    return true;
  }

  // ── PHASE 4: Deploy preview ──
  if (type === "deploy_preview") {
    const now = new Date().toISOString();

    // 1. Buscar proyecto generado en Phase 3
    const { data: assembleTasks } = await supabase.from("agent_tasks")
      .select("output_json").eq("work_order_id", workOrderId)
      .in("task_type", ["assemble_nextjs_project","web_generate"]).eq("status","done").limit(1);
    const assembleOutput = assembleTasks?.[0]?.output_json;

    if (!assembleOutput?.project_dir) {
      await supabase.from("agent_events").insert({
        work_order_id: workOrderId, actor: "web-worker",
        event_type: "deploy_failed",
        message: "No se encontro proyecto generado. Ejecuta primero assemble_nextjs_project.",
        payload_json: { reason: "no_project_dir" }, created_at: now
      });
      throw new Error("No se encontro proyecto generado para deployar");
    }

    const { project_dir, project_slug } = assembleOutput;

    // 2. Validar que los archivos existen en disco
    if (!existsSync(join(project_dir, "app", "page.tsx"))) {
      await supabase.from("agent_events").insert({
        work_order_id: workOrderId, actor: "web-worker",
        event_type: "deploy_failed",
        message: `Archivos no encontrados en disco: ${project_dir}`,
        payload_json: { project_dir, project_slug }, created_at: now
      });
      throw new Error("Archivos del proyecto no existen en disco: " + project_dir);
    }

    // 3. Evento: deploy_started
    await supabase.from("agent_events").insert({
      work_order_id: workOrderId, actor: "web-worker",
      event_type: "deploy_started",
      message: `Iniciando build y deploy de ${project_slug}`,
      payload_json: { project_dir, project_slug }, created_at: now
    });
    log(`Iniciando deploy: ${project_slug}`);

    // 4. Build
    let outDir;
    try {
      outDir = buildProject(project_dir);
    } catch (buildErr) {
      const errMsg = "El build de la web ha fallado. Reintentando en la proxima ejecucion.";
      await supabase.from("agent_events").insert([
        {
          work_order_id: workOrderId, actor: "web-worker",
          event_type: "deploy_failed",
          message: "Build fallido: " + buildErr.message.slice(0, 200),
          payload_json: { project_slug, error: buildErr.message.slice(0, 300) },
          created_at: new Date().toISOString()
        },
        {
          work_order_id: workOrderId, actor: "web-worker",
          event_type: "telegram_notification_sent",
          message: errMsg,
          payload_json: { milestone: "deploy_failed", error: buildErr.message.slice(0, 100) },
          created_at: new Date().toISOString()
        }
      ]);
      await tg(errMsg, chatId);

    // 5. Deploy a Cloudflare
    let url;
    try {
      url = await deployToCloudflare(project_slug, outDir);
    } catch (deployErr) {
      await supabase.from("agent_events").insert({
        work_order_id: workOrderId, actor: "web-worker",
        event_type: "deploy_failed",
        message: "Deploy a Cloudflare fallido: " + deployErr.message.slice(0, 200),
        payload_json: { project_slug, error: deployErr.message.slice(0, 300) },
        created_at: new Date().toISOString()
      });
      await supabase.from("agent_tasks").update({
        status: "failed", error_message: deployErr.message.slice(0, 300),
        output_json: { project_slug, deploy_failed: true },
        completed_at: new Date().toISOString()
      }).eq("id", task.id);
      throw deployErr;
    }

    // 6. Validar URL real antes de guardarla
    if (!url || !url.startsWith("http")) {
      const err = "URL de deploy invalida: " + String(url).slice(0, 100);
      await supabase.from("agent_events").insert({
        work_order_id: workOrderId, actor: "web-worker",
        event_type: "deploy_failed", message: err,
        payload_json: { project_slug, url }, created_at: new Date().toISOString()
      });
      throw new Error(err);
    }

    // 7. Guardar URL real en BD
    const completedAt = new Date().toISOString();
    await supabase.from("agent_tasks").update({
      status: "done",
      output_json: { url, project_slug, deployed_at: completedAt },
      completed_at: completedAt
    }).eq("id", task.id);

    // Guardar en work_orders metadata
    const woMeta = await getWoMetadata(workOrderId);
    await supabase.from("work_orders").update({
      metadata: { ...woMeta, preview_url: url, project_slug, deployed_at: completedAt },
      status: "in_progress", updated_at: completedAt
    }).eq("id", workOrderId);

    // Guardar en website_projects si existe (buscar por work_order_id)
    const { data: wp } = await supabase.from("website_projects")
      .select("id").eq("work_order_id", workOrderId).limit(1);
    if (wp?.[0]?.id) {
      await supabase.from("website_projects").update({
        preview_url: url, status: "deployed", updated_at: completedAt
      }).eq("id", wp[0].id);
    }

    // 8. Evento: deploy_succeeded
    await supabase.from("agent_events").insert({
      work_order_id: workOrderId, actor: "web-worker",
      event_type: "deploy_succeeded",
      message: `Preview publicada: ${url}`,
      payload_json: { url, project_slug, deployed_at: completedAt },
      created_at: completedAt
    });

    log(`Deploy completo: ${url}`);
    return true;
  }

  // ── Notify Telegram ──
  if (type === "notify_telegram") {
    const { data: deployTasks } = await supabase.from("agent_tasks")
      .select("output_json").eq("work_order_id", workOrderId)
      .eq("task_type", "deploy_preview").eq("status", "done").limit(1);

    const url = deployTasks?.[0]?.output_json?.url;
    const now = new Date().toISOString();

    if (url && url.startsWith("http")) {
      // ── PHASE 5: Milestone 4 — Preview lista ──
      const msg = `Tu web esta lista:\n\n${url}\n\nEs una preview — puedes revisarla y pedirme cambios.`;
      await tg(msg, chatId);
      await supabase.from("work_orders").update({
        status: "completed", updated_at: now
      }).eq("id", workOrderId);
      await supabase.from("agent_events").insert({
        work_order_id: workOrderId, actor: "web-worker",
        event_type: "telegram_notification_sent",
        message: msg,
        payload_json: { milestone: "preview_ready", url, chat_id: chatId },
        created_at: now
      });
    } else {
      await tg("La web se genero pero no hay URL de preview disponible aun. Revisalo en unos minutos.", chatId);
    }

    await supabase.from("agent_tasks").update({
      status: "done", output_json: { notified: !!url, url: url || null },
      completed_at: now
    }).eq("id", task.id);
    return true;
  }

  // Tipo desconocido — skip
  log(`Tipo desconocido: ${type} — skip`);
  await supabase.from("agent_tasks").update({
    status: "done", output_json: { skipped: true, reason: "unknown_type" },
    completed_at: new Date().toISOString()
  }).eq("id", task.id);
  return true;
}

async function getWoMetadata(workOrderId) {
  const { data } = await supabase.from("work_orders").select("metadata").eq("id", workOrderId).single();
  return data?.metadata || {};
}

// ── CLAIM + LOOP ──────────────────────────────────────────────────────────

async function claimTask() {
  try {
    const { data: tasks } = await supabase.from("agent_tasks").select("*")
      .eq("status", "pending").order("sequence_order", { ascending: true }).limit(30);
    if (!tasks?.length) return null;

    for (const task of tasks) {
      const type = task.task_type || task.input_json?.task_type || "";
      if (!HANDLED_TYPES.includes(type) && type !== "web_generate") continue;

      // Verificar dependencias por sequence_order
      if (task.depends_on?.length) {
        const depSeqs = task.depends_on;
        const { data: siblings } = await supabase.from("agent_tasks")
          .select("sequence_order,status")
          .eq("work_order_id", task.work_order_id)
          .lt("sequence_order", task.sequence_order);
        const allDone = depSeqs.every(seq =>
          siblings?.find(s => s.sequence_order === seq && (s.status === "done" || s.status === "skipped"))
        );
        if (!allDone) continue;
      }

      const { data: claimed, error } = await supabase.from("agent_tasks")
        .update({ status: "running", started_at: new Date().toISOString() })
        .eq("id", task.id).eq("status", "pending").select().single();
      if (!error && claimed) return claimed;
    }
    return null;
  } catch (e) { log("claimTask: " + e.message); return null; }
}

async function processTask() {
  const task = await claimTask();
  if (!task) return false;
  const chatId = task.input_json?.chat_id || task.input_json?.telegram_chat_id || CHAT;
  log(`Procesando [${task.task_type}]: ${task.title}`);
  try {
    await handleTask(task);
  } catch (err) {
    log(`Error en ${task.task_type}: ${err.message}`);
    await supabase.from("agent_tasks").update({
      status: "failed", error_message: err.message.slice(0, 300),
      completed_at: new Date().toISOString()
    }).eq("id", task.id);
    await tg(`Error en ${task.task_type}: ${err.message.slice(0, 120)}`, chatId);
  }
  return true;
}

async function heartbeat() {
  try {
    await supabase.from("worker_health").upsert({
      worker_name: "horizon-web-worker", status: "online",
      heartbeat_at: new Date().toISOString()
    }, { onConflict: "worker_name" });
  } catch {}
}

async function main() {
  mkdirSync(SITES_DIR, { recursive: true });
  log(`Horizon Web Worker (Phases 3+4) — sites dir: ${SITES_DIR}`);
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
