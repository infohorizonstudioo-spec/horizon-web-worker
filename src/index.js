import "dotenv/config";
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.OWNER_TELEGRAM_CHAT_ID;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const POLL_MS = parseInt(process.env.POLLING_INTERVAL_MS || "6000");
const MY_ROLES = ["frontend", "worker"];
const MY_TYPES = ["web_generate", "web_deploy"];

function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] [WEB] ${msg}`); }

async function tg(text, chatId) {
  const target = chatId || CHAT;
  if (!BOT || !target) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: target, text: text.slice(0, 4096) }),
    });
  } catch {}
}

async function ensurePagesProject(projectName) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/pages/projects`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: projectName, production_branch: "main" })
    }
  );
  const data = await res.json();
  // Si ya existe (error 8000007) lo ignoramos
  if (!res.ok && !JSON.stringify(data).includes("8000007") && !JSON.stringify(data).includes("already exists")) {
    log(`ensureProject warn: ${JSON.stringify(data).slice(0, 150)}`);
  }
}

async function deployToCloudflare(projectName, html) {
  await ensurePagesProject(projectName);

  // Hash MD5 del contenido
  const hash = crypto.createHash("md5").update(html).digest("hex");

  // FormData con manifest + archivo
  const formData = new FormData();
  formData.append("manifest", JSON.stringify({ "/index.html": hash }));
  formData.append(`files[${hash}]`, new Blob([html], { type: "text/html" }), "index.html");

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/pages/projects/${projectName}/deployments`,
    { method: "POST", headers: { "Authorization": `Bearer ${CF_TOKEN}` }, body: formData }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.errors?.[0]?.message || JSON.stringify(data).slice(0, 200));

  // Usar URL del deployment directo — la URL del proyecto tarda minutos en activarse
  const deployUrl = data.result?.url || `https://${projectName}.pages.dev`;
  return deployUrl;
}

async function generateWebsite(task) {
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514", max_tokens: 8192,
    messages: [{ role: "user", content:
      `Eres un diseñador web experto. Crea una landing page PROFESIONAL y COMPLETA.\n\n` +
      `BRIEFING:\n${task.input_prompt}\n\n` +
      `REQUISITOS OBLIGATORIOS:\n` +
      `- Todo en un único index.html con CSS y JS embebidos\n` +
      `- Diseño MODERNO y PREMIUM — no básico, no genérico\n` +
      `- 100% responsive y mobile-first con media queries reales\n` +
      `- Usa Google Fonts (importa desde fonts.googleapis.com)\n` +
      `- Usa imágenes reales de Unsplash (https://images.unsplash.com/photo-XXXXX?w=1200&q=80)\n` +
      `- Paleta de colores coherente y profesional, con variables CSS\n` +
      `- Animaciones suaves: fade-in al scroll con IntersectionObserver\n` +
      `- Navegación fija con scroll suave entre secciones\n` +
      `- Hero section impactante con imagen de fondo y overlay\n` +
      `- Secciones bien definidas con padding generoso\n` +
      `- Botones CTA con hover effects\n` +
      `- Footer completo con info de contacto\n` +
      `- SEO: title, description, Open Graph, Schema.org\n` +
      `- El formulario de contacto debe tener estilos completos\n` +
      `- NUNCA uses Bootstrap ni frameworks externos — CSS propio\n\n` +
      `Devuelve SOLO el HTML completo empezando con <!DOCTYPE html>. Sin explicaciones.`
    }]
  });
  const html = msg.content.filter(b => b.type === "text").map(b => b.text).join("").trim()
    .replace(/^```html\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!html.includes("<!DOCTYPE") && !html.includes("<html")) throw new Error("HTML invalido: " + html.slice(0, 100));
  return html;
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

async function completeTask(taskId, woId, success, summary, url, error) {
  // summary nunca debe contener HTML — solo la URL o texto corto
  const safeSummary = url ? `Publicada en ${url}` : (summary || "").slice(0, 200).replace(/<[^>]*>/g, "");
  await supabase.from("agent_tasks").update({
    status: success ? "done" : "failed",
    output_json: { summary: safeSummary, url, worker: "web-worker" },
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
  const chatId = task.input_json?.chat_id || task.input_json?.telegram_chat_id || CHAT;
  log(`Procesando: ${task.title}`);
  try {
    const config = task.input_json?.config || {};
    const projectName = (config.project_name || `horizon-${Date.now().toString(36)}`).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
    const html = await generateWebsite(task);
    log(`HTML generado: ${html.length} chars`);

    if (!CF_TOKEN || !CF_ACCOUNT) {
      await completeTask(task.id, task.work_order_id, true, `Código generado (${html.length} chars). Configura CLOUDFLARE_API_TOKEN y CLOUDFLARE_ACCOUNT_ID.`, null, null);
      await tg(`El código de la web está listo pero falta configurar Cloudflare.`, chatId);
      return true;
    }

    const url = await deployToCloudflare(projectName, html);
    if (!url || !url.startsWith("http")) throw new Error("Deploy fallido, URL invalida: "+String(url).slice(0,50));
    log(`Publicado: ${url}`);
    await completeTask(task.id, task.work_order_id, true, `Publicada en ${url}`, url, null);
    await tg(`Aqui tienes la web:\n\n${url}`, chatId);

    const { data: pending } = await supabase.from("agent_tasks").select("id")
      .eq("work_order_id", task.work_order_id).not("status", "in", '("done","skipped","failed")');
    if (!pending?.length) {
      await supabase.from("work_orders").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", task.work_order_id);
    }
  } catch (err) {
    log("Error: " + err.message);
    await completeTask(task.id, task.work_order_id, false, null, null, err.message);
    await tg(`Algo falló generando la web: ${err.message.slice(0, 100)}`, chatId);
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
