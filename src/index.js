import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.OWNER_TELEGRAM_CHAT_ID;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const POLL_MS = parseInt(process.env.POLLING_INTERVAL_MS || "6000");
const MY_ROLES = ["frontend"];
const MY_TYPES = ["web_generate", "web_deploy"];

function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] [WEB] ${msg}`); }

async function tg(text) {
  if (!BOT || !CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text: text.slice(0, 4096), parse_mode: "Markdown" }),
    });
  } catch {}
}

async function deployToVercel(projectName, html) {
  const res = await fetch("https://api.vercel.com/v13/deployments", {
    method: "POST",
    headers: { "Authorization": `Bearer ${VERCEL_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: projectName,
      files: [{ file: "index.html", data: Buffer.from(html).toString("base64"), encoding: "base64" }],
      projectSettings: { framework: null, buildCommand: null, outputDirectory: null },
      target: "production"
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data).slice(0, 100));
  const deployId = data.id;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const check = await fetch(`https://api.vercel.com/v13/deployments/${deployId}`, {
      headers: { "Authorization": `Bearer ${VERCEL_TOKEN}` }
    });
    const s = await check.json();
    if (s.readyState === "READY") return `https://${s.url}`;
    if (s.readyState === "ERROR") throw new Error("Vercel build failed");
  }
  return `https://${data.url}`;
}

async function generateWebsite(task) {
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514", max_tokens: 8192,
    messages: [{ role: "user", content:
      `Eres experto en diseño web y SEO. Genera un sitio web completo y profesional.\n\n` +
      `BRIEFING:\n${task.input_prompt}\n\n` +
      `REGLAS:\n- Todo en un único index.html (HTML+CSS+JS embebido)\n` +
      `- Responsive, mobile-first, diseño moderno y atractivo\n` +
      `- SEO completo: meta tags, Open Graph, Schema.org\n` +
      `- Si hay fotos, usa las URLs directamente\n` +
      `- Devuelve SOLO el HTML, empieza con <!DOCTYPE html>`
    }]
  });
  const html = msg.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
  if (!html.includes("<!DOCTYPE") && !html.includes("<html")) throw new Error("HTML inválido");
  return html;
}

async function claimTask() {
  try {
    const { data: tasks } = await supabase.from("agent_tasks").select("*")
      .eq("status", "pending").order("sequence_order", { ascending: true }).limit(20);
    if (!tasks?.length) return null;
    for (const task of tasks) {
      const execType = task.input_json?.execution_type || "";
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

async function completeTask(taskId, woId, success, summary, url, error) {
  await supabase.from("agent_tasks").update({
    status: success ? "done" : "failed",
    output_json: { summary, url, worker: "web-worker" },
    error_message: error, completed_at: new Date().toISOString()
  }).eq("id", taskId);
  await supabase.from("agent_events").insert({
    work_order_id: woId, task_id: taskId, agent_name: "web-worker",
    event_type: success ? "web_deployed" : "web_failed",
    message: success ? `Web publicada: ${url}` : `Error: ${error}`,
    payload_json: { url, summary }
  });
  try { await supabase.rpc("update_work_order_progress", { p_work_order_id: woId }); } catch {}
}

async function processTask() {
  const task = await claimTask();
  if (!task) return false;
  log(`Procesando: ${task.title}`);
  try {
    const config = task.input_json?.config || {};
    const projectName = (config.project_name || `horizon-${Date.now().toString(36)}`).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
    const html = await generateWebsite(task);
    log(`HTML generado: ${html.length} chars`);

    if (!VERCEL_TOKEN || VERCEL_TOKEN === "PENDIENTE") {
      await completeTask(task.id, task.work_order_id, true, `Código generado (${html.length} chars). Configura VERCEL_TOKEN para publicar.`, null, null);
      await tg(`✅ *${task.title}*\n\nEl código de la web está listo. En cuanto configures Vercel lo publico automáticamente.`);
      return true;
    }

    const url = await deployToVercel(projectName, html);
    log(`Publicado: ${url}`);
    await completeTask(task.id, task.work_order_id, true, `Publicada en ${url}`, url, null);
    await tg(`🌐 *${task.title}*\n\nListo, ya está publicada:\n${url}\n\n_Optimizada para SEO y mobile._`);

    const { data: pending } = await supabase.from("agent_tasks").select("id")
      .eq("work_order_id", task.work_order_id).not("status", "in", '("done","skipped","failed")');
    if (!pending?.length) {
      await supabase.from("work_orders").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", task.work_order_id);
      await tg(`🎉 *Todo listo.*`);
    }
  } catch (err) {
    log("Error: " + err.message);
    await completeTask(task.id, task.work_order_id, false, null, null, err.message);
    await tg(`⚠️ *${task.title}*\n\nAlgo falló generando la web. Inténtalo de nuevo.`);
  }
  return true;
}

async function heartbeat() {
  try { await supabase.from("worker_health").upsert({ worker_name: "horizon-web-worker", status: "online", heartbeat_at: new Date().toISOString() }, { onConflict: "worker_name" }); } catch {}
}

async function main() {
  log("Horizon Web Worker activo");
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
