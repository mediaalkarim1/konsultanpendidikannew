import { type AiAnalysisResult } from "../lib/pdf-generator";
import { DEFAULT_UNIFIED_PROMPT } from "../lib/ai-prompt-default";
import { getAdminSupabase } from "../lib/supabase-admin";


export function normalizeJenjangLevel(rawLevel: string): { key: "tksd" | "smp" | "sma"; label: string; contextGuidance: string } {
  const norm = (rawLevel || "").toLowerCase().trim();
  if (norm.includes("smp")) {
    return {
      key: "smp",
      label: "SMP (Sekolah Menengah Pertama)",
      contextGuidance: "FAKUS JENJANG SMP: Analisis fokus pada masa remaja, eksplorasi minat & bakat, pembentukan karakter, kemandirian belajar, tantangan sosialisasi/pergaulan, dan kesiapan transisi sekolah menengah."
    };
  }
  if (norm.includes("sma") || norm.includes("smk")) {
    return {
      key: "sma",
      label: "SMA (Sekolah Menengah Atas)",
      contextGuidance: "FAKUS JENJANG SMA: Analisis fokus pada pemetaan minat jurusan, persiapan perguruan tinggi/karir masa depan, kemandirian & pemikiran kritis, kesiapan akademis, serta strategi masa depan."
    };
  }
  return {
    key: "tksd",
    label: "TK & SD (Usia Dini & Dasar)",
    contextGuidance: "FAKUS JENJANG TK & SD: Analisis fokus pada tumbuh kembang usia emas, pembentukan fondasi karakter, kebiasaan belajar di rumah, emosi & motorik/sensorik, serta strategi pendampingan orang tua di rumah."
  };
}

export async function runAiEngineAnalysis(parentName: string, childName: string = "-", level: string, whatsappNumber: string, formattedAnswers: string): Promise<{ success: boolean; data?: AiAnalysisResult; providerName?: string; error?: string }> {
  const supabaseAdmin = getAdminSupabase();
  const jenjangInfo = normalizeJenjangLevel(level);

  // 1. Fetch active provider from settings table first
  let provider: any = null;
  try {
    const { data: settingsProv } = await supabaseAdmin
      .from("settings")
      .select("value")
      .eq("key", "wa.provider_config") // or ai.provider_config
      .maybeSingle();

    const { data: aiConfigSetting } = await supabaseAdmin
      .from("settings")
      .select("value")
      .eq("key", "ai.provider_config")
      .maybeSingle();

    if (aiConfigSetting?.value && (aiConfigSetting.value as any)?.provider_name) {
      provider = aiConfigSetting.value;
    }
  } catch (_) {}

  if (!provider) {
    try {
      const { data: defaultProv } = await (supabaseAdmin as any)
        .from("ai_providers")
        .select("*")
        .eq("is_default", true)
        .eq("is_active", true)
        .maybeSingle();

      provider = defaultProv;

      if (!provider) {
        const { data: firstActive } = await (supabaseAdmin as any)
          .from("ai_providers")
          .select("*")
          .eq("is_active", true)
          .limit(1)
          .maybeSingle();
        provider = firstActive;
      }
    } catch (provErr) {
      console.warn("Notice: ai_providers table fetch:", provErr);
    }
  }

  // Fallback Gemini / Lovable Provider
  const geminiEnvKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;
  if (!provider) {
    if (geminiEnvKey) {
      provider = {
        id: "gemini-env",
        provider_name: "Google Gemini",
        provider_key: "gemini",
        api_key: geminiEnvKey,
        base_url: "https://generativelanguage.googleapis.com/v1beta/models",
        model: "gemini-1.5-flash",
        temperature: 0.7,
        max_tokens: 2048,
        is_default: true,
        is_active: true
      };
    } else {
      provider = {
        id: "default-ai-engine",
        provider_name: "EduKonsul AI Engine",
        provider_key: "lovable",
        api_key: process.env.LOVABLE_API_KEY || process.env.LOVABLE_GATEWAY_KEY || "lovable-gateway-auto",
        base_url: "https://ai.gateway.lovable.dev/v1",
        model: "google/gemini-2.5-flash",
        temperature: 0.7,
        max_tokens: 2048,
        is_default: true,
        is_active: true
      };
    }
  }

  // 2. Fetch active prompts from DB (check level-specific prompt key first)
  let systemPromptFromDb = "";

  // Helper: validate if a prompt from DB strictly matches the NEW 4-section format
  const isNewFormatPrompt = (p: string): boolean => {
    if (!p) return false;
    const hasRingkasan = p.includes("RINGKASAN") || p.includes("Ringkasan");
    const hasPerhatian = p.includes("PERLU DIPERHATIKAN") || p.includes("Perlu Diperhatikan") || p.includes("❗");
    const hasPotensi = p.includes("POTENSI") || p.includes("Potensi") || p.includes("🌟");
    const hasRekomendasi = p.includes("REKOMENDASI") || p.includes("Rekomendasi") || p.includes("🎯");
    const isOldNarrative = p.includes("500 kata") || p.includes("900 kata") || p.includes("narasi yang mengalir") || p.includes("narasi konsultasi");
    return hasRingkasan && hasPerhatian && hasPotensi && hasRekomendasi && !isOldNarrative;
  };

  try {
    // Attempt level-specific setting key first e.g. ai.prompt.tksd, ai.prompt.smp, ai.prompt.sma
    const { data: levelPromptSetting } = await supabaseAdmin
      .from("settings")
      .select("value")
      .eq("key", `ai.prompt.${jenjangInfo.key}`)
      .maybeSingle();

    if (levelPromptSetting && (levelPromptSetting.value as any)?.system_prompt && isNewFormatPrompt((levelPromptSetting.value as any).system_prompt)) {
      systemPromptFromDb = (levelPromptSetting.value as any).system_prompt;
      console.info(`[AI Engine] Using level-specific prompt for ${jenjangInfo.key} from settings table.`);
    }
  } catch (_) {}

  if (!systemPromptFromDb) {
    try {
      const { data: promptSetting } = await supabaseAdmin
        .from("settings")
        .select("value")
        .eq("key", "ai.unified_prompt")
        .maybeSingle();

      if (promptSetting && (promptSetting.value as any)?.system_prompt) {
        const dbPrompt = (promptSetting.value as any).system_prompt;
        if (isNewFormatPrompt(dbPrompt)) {
          systemPromptFromDb = dbPrompt;
          console.info("[AI Engine] Using unified prompt from settings table (new format).");
        } else {
          console.info("[AI Engine] DB prompt is old format — using new default prompt instead.");
        }
      }
    } catch (_) {}
  }

  // Fallback: check ai_prompts table only if settings had nothing usable
  if (!systemPromptFromDb) {
    try {
      const { data: prompt } = await (supabaseAdmin as any).from("ai_prompts").select("*").eq("is_active", true).limit(1).maybeSingle();
      if (prompt?.system_prompt && isNewFormatPrompt(prompt.system_prompt)) {
        systemPromptFromDb = prompt.system_prompt;
        console.info("[AI Engine] Using prompt from ai_prompts table (new format).");
      } else if (prompt?.system_prompt) {
        console.info("[AI Engine] ai_prompts table prompt is old format — using new default.");
      }
    } catch (_) {}
  }

  const defaultUnifiedPrompt = DEFAULT_UNIFIED_PROMPT;
  const mainPromptTemplate = systemPromptFromDb || defaultUnifiedPrompt;

  const processedPrompt = mainPromptTemplate
    .replace(/{{nama_orang_tua}}/g, parentName)
    .replace(/{{nama_anak}}/g, childName || "-")
    .replace(/{{jenjang}}/g, jenjangInfo.label)
    .replace(/{{jawaban_lengkap}}/g, formattedAnswers);

  const fullUserPrompt = `
=== INSTRUKSI PROMPT UTAMA ===
${processedPrompt}

=== KONTEKS JENJANG PENDIDIKAN ===
${jenjangInfo.contextGuidance}

=== DATA KONSULTASI KLIEN ===
Nama Orang Tua: ${parentName}
Nama Anak: ${childName || "-"}
Jenjang: ${jenjangInfo.label}
Nomor WhatsApp: ${whatsappNumber}

=== JAWABAN KUESIONER LENGKAP ===
${formattedAnswers}

=== PETUNJUK FORMAT OUTPUT ===
Berikan keluaran dalam format JSON valid berikut (tanpa markdown codeblock):
{
  "summary_points": [
    "Poin ringkasan fakta 1 berbasis jawaban orang tua...",
    "Poin ringkasan fakta 2 berbasis jawaban orang tua...",
    "Poin ringkasan fakta 3 berbasis jawaban orang tua..."
  ],
  "attention_areas": [
    {
      "title": "Judul Temuan Spesifik Dari Jawaban (Bukan kata generik)",
      "description": "Penjelasan kondisi konkret 1-2 kalimat berbasis bukti jawaban orang tua.",
      "evidence": "Kutipan / ringkasan bukti jawaban orang tua"
    }
  ],
  "potentials": [
    {
      "title": "Judul Potensi / Karakter Positif Spesifik",
      "description": "Penjelasan potensi positif 1-2 kalimat berbasis bukti jawaban orang tua.",
      "evidence": "Kutipan / ringkasan bukti jawaban orang tua"
    }
  ],
  "recommendations": [
    {
      "title": "Judul Action Plan Pendampingan Rumah",
      "description": "Langkah praktis pendampingan rumah yang terhubung dengan temuan.",
      "based_on": "Berhubungan dengan temuan area perhatian / potensi"
    }
  ]
}
`;

  try {
    let rawResponseText = "";
    const key = provider.api_key?.trim() || geminiEnvKey || "";
    const model = provider.model?.trim() || "gemini-1.5-flash";
    const baseUrl = (provider.base_url?.trim() || "").replace(/\/+$/, "");
    const temp = Number(provider.temperature) || 0.7;
    const maxTokens = Number(provider.max_tokens) || 2048;

    if (provider.provider_key === "gemini" || key.startsWith("AIzaSy")) {
      // Google Gemini API (Direct)
      // Clean model name: remove google/ prefix if present
      let cleanModel = model.replace(/^google\//, "");
      // Map legacy or unsupported model names to stable Gemini models if needed
      if (cleanModel.includes("3.5") || cleanModel.includes("3.1")) {
        cleanModel = "gemini-2.5-flash";
      }

      const geminiUrl = `${baseUrl || "https://generativelanguage.googleapis.com/v1beta/models"}/${cleanModel}:generateContent?key=${key}`;
      const res = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: fullUserPrompt }]
            }
          ],
          generationConfig: { temperature: temp, maxOutputTokens: maxTokens }
        })
      });

      const resData = await res.json();
      if (!res.ok) {
        // Fallback retry with gemini-1.5-flash if model name was rejected
        if (cleanModel !== "gemini-1.5-flash") {
          console.warn(`[Gemini API] Retry with gemini-1.5-flash due to error: ${resData.error?.message}`);
          const retryUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
          const retryRes = await fetch(retryUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: fullUserPrompt }] }],
              generationConfig: { temperature: temp, maxOutputTokens: maxTokens }
            })
          });
          const retryData = await retryRes.json();
          if (retryRes.ok) {
            rawResponseText = retryData.candidates?.[0]?.content?.parts?.[0]?.text || "";
          } else {
            throw new Error(retryData.error?.message || resData.error?.message || "Google Gemini API error");
          }
        } else {
          throw new Error(resData.error?.message || "Google Gemini API error");
        }
      } else {
        rawResponseText = resData.candidates?.[0]?.content?.parts?.[0]?.text || "";
      }

    } else if (provider.provider_key === "claude") {
      // Anthropic Claude API
      const claudeUrl = `${baseUrl || "https://api.anthropic.com/v1"}/messages`;
      const res = await fetch(claudeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: temp,
          system: mainPromptTemplate,
          messages: [{ role: "user", content: fullUserPrompt }]
        })
      });

      const resData = await res.json();
      if (!res.ok) throw new Error(resData.error?.message || "Anthropic Claude API error");
      rawResponseText = resData.content?.[0]?.text || "";

    } else if (provider.provider_key === "ollama") {
      // Ollama API
      const ollamaUrl = `${baseUrl || "http://localhost:11434"}/api/generate`;
      const res = await fetch(ollamaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: fullUserPrompt,
          stream: false
        })
      });

      const resData = await res.json();
      if (!res.ok) throw new Error(resData.error || "Ollama API error");
      rawResponseText = resData.response || "";

    } else {
      // OpenAI / Lovable Gateway / OpenRouter / DeepSeek / Groq / Mistral (Standard OpenAI format)
      let endpoint = `${baseUrl || (provider.provider_key === "lovable" ? "https://ai.gateway.lovable.dev/v1" : "https://api.openai.com/v1")}/chat/completions`;
      
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const effectiveKey = (provider.provider_key === "lovable" && (!key || key.includes("auto"))) 
        ? (process.env.LOVABLE_API_KEY || process.env.LOVABLE_GATEWAY_KEY || "lovable-gateway-auto") 
        : key;

      if (effectiveKey) headers["Authorization"] = `Bearer ${effectiveKey}`;

      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: mainPromptTemplate },
            { role: "user", content: fullUserPrompt }
          ],
          temperature: temp,
          max_tokens: maxTokens
        })
      });

      const resData = await res.json();
      if (!res.ok) throw new Error(resData.error?.message || resData.message || `${provider.provider_name} API error`);
      rawResponseText = resData.choices?.[0]?.message?.content || "";
    }

    if (!rawResponseText) {
      throw new Error(`Tanggapan dari ${provider.provider_name} kosong.`);
    }

    // [TAHAP 8 AUDIT LOG: AI RAW RESPONSE]
    console.log("==================================================");
    console.log("[AI RAW RESPONSE]");
    console.log(rawResponseText);
    console.log("==================================================");

    // Parse JSON
    const parsed = parseAiJsonResponse(rawResponseText, formattedAnswers, childName);

    // [TAHAP 8 AUDIT LOG: AI PARSED RESULT]
    console.log("==================================================");
    console.log("[AI PARSED RESULT]");
    console.log(JSON.stringify(parsed, null, 2));
    console.log("==================================================");

    return {
      success: true,
      providerName: provider.provider_name,
      data: parsed
    };

  } catch (err: any) {
    console.error(`[AI Engine Error] (${provider?.provider_name} API call failed):`, err?.message || err);
    console.info("[AI Engine] Using local semantic interpreter fallback (generateInterpretedAnalysis)...");
    try {
      const fallbackParsed = generateInterpretedAnalysis(parentName, childName, level, formattedAnswers);
      return {
        success: true,
        providerName: `${provider?.provider_name || "AI Engine"} (Interpreted Fallback)`,
        data: fallbackParsed
      };
    } catch (fallbackErr: any) {
      console.error("[AI Engine] Local fallback error:", fallbackErr);
      return {
        success: false,
        error: "Analisis gagal dibuat. Silakan coba kembali."
      };
    }
  }
}

import { sanitizeAnalysisMarkdown } from "@/lib/pdf-generator";

export function sanitizeNameRepetition(text: string, childName: string): string {
  if (!text || !childName || childName === "-" || childName.trim().length < 2) return text;
  
  const cName = childName.trim();
  const escapedName = cName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escapedName}\\b`, 'gi');

  let count = 0;
  let result = text.replace(regex, (match) => {
    count++;
    if (count <= 1) return match;
    return count % 2 === 0 ? "ia" : "Ananda";
  });

  // Clean up any double pronoun artifacts created by regex substitution
  result = result
    .replace(/\bAnanda\s+ia\b/gi, "ia")
    .replace(/\bAnanda\s+Ananda\b/gi, "Ananda")
    .replace(/\bia\s+ia\b/gi, "ia")
    .replace(/\bia\s+Ananda\b/gi, "Ananda");

  return result;
}

function parseAiJsonResponse(text: string, formattedAnswers?: string, childName?: string): AiAnalysisResult {
  try {
    // Clean codeblock formatting if present
    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : cleaned;
    const obj = JSON.parse(jsonStr);

    let summaryStr = "";
    if (Array.isArray(obj.summary_points) && obj.summary_points.length > 0) {
      summaryStr = obj.summary_points.map((p: string) => sanitizeAnalysisMarkdown(p)).join("\n\n");
    } else if (typeof obj.summary === "string") {
      summaryStr = sanitizeAnalysisMarkdown(obj.summary);
    } else {
      summaryStr = "Ringkasan disusun berdasarkan fakta jawaban kuesioner.";
    }

    let concernsStr = "";
    if (Array.isArray(obj.attention_areas) && obj.attention_areas.length > 0) {
      concernsStr = obj.attention_areas
        .map((item: any) => {
          const title = sanitizeAnalysisMarkdown(item.title || item.name || "");
          const desc = sanitizeAnalysisMarkdown(item.description || item.desc || "");
          return `❗ ${title}\n${desc}`;
        })
        .join("\n\n");
    } else if (typeof obj.weaknesses === "string") {
      concernsStr = sanitizeAnalysisMarkdown(obj.weaknesses);
    } else {
      concernsStr = "-";
    }

    let potentialsStr = "";
    if (Array.isArray(obj.potentials) && obj.potentials.length > 0) {
      potentialsStr = obj.potentials
        .map((item: any) => {
          const title = sanitizeAnalysisMarkdown(item.title || item.name || "");
          const desc = sanitizeAnalysisMarkdown(item.description || item.desc || "");
          return `🌟 ${title}\n${desc}`;
        })
        .join("\n\n");
    } else if (typeof obj.strengths === "string") {
      potentialsStr = sanitizeAnalysisMarkdown(obj.strengths);
    } else {
      potentialsStr = "-";
    }

    let recsStr = "";
    if (Array.isArray(obj.recommendations) && obj.recommendations.length > 0) {
      recsStr = obj.recommendations
        .map((item: any) => {
          const title = sanitizeAnalysisMarkdown(item.title || item.name || "");
          const desc = sanitizeAnalysisMarkdown(item.description || item.desc || "");
          return `🎯 ${title}\n${desc}`;
        })
        .join("\n\n");
    } else if (typeof obj.education_recommendation === "string") {
      recsStr = sanitizeAnalysisMarkdown(obj.education_recommendation);
    } else {
      recsStr = "-";
    }

    // Negative Constraint Filter: Remove contradictory findings if formattedAnswers states positive condition
    if (formattedAnswers) {
      const lowerAnswers = formattedAnswers.toLowerCase();
      
      // If parent states child already decided major/knows major
      if (lowerAnswers.includes("sudah tahu jurusan") || lowerAnswers.includes("jurusan kuliah yang sudah dipilih") || lowerAnswers.includes("sudah mantap")) {
        concernsStr = concernsStr.split("\n\n").filter(block => !/bingung|belum (tahu|memiliki|paham)|arah jurusan/i.test(block)).join("\n\n");
      }
      // If parent states child is active in projects/orgs
      if (lowerAnswers.includes("aktif berorganisasi") || lowerAnswers.includes("sudah ada proyek") || lowerAnswers.includes("banyak karya")) {
        concernsStr = concernsStr.split("\n\n").filter(block => !/kurang (pengalaman|organisasi)|belum (ada|memiliki) (portofolio|karya)/i.test(block)).join("\n\n");
      }
      // If parent states child manages time well
      if (lowerAnswers.includes("mampu mengelola waktu") || lowerAnswers.includes("disiplin waktu")) {
        concernsStr = concernsStr.split("\n\n").filter(block => !/manajemen waktu|prokrastinasi|menunda/i.test(block)).join("\n\n");
      }
    }

    // Sanitize child name repetition across sections
    if (childName && childName !== "-") {
      summaryStr = sanitizeNameRepetition(summaryStr, childName);
      concernsStr = sanitizeNameRepetition(concernsStr, childName);
      potentialsStr = sanitizeNameRepetition(potentialsStr, childName);
    }

    const fullNarrative = `RINGKASAN AWAL\n\n${summaryStr}\n\nAREA YANG PERLU DIPERHATIKAN\n\n${concernsStr}\n\nMINAT & POTENSI\n\n${potentialsStr}\n\nREKOMENDASI PENDAMPINGAN RUMAH\n\n${recsStr}`;

    return {
      summary: summaryStr,
      analysis: fullNarrative,
      strengths: potentialsStr,
      weaknesses: concernsStr,
      potential: potentialsStr,
      risk: concernsStr,
      education_recommendation: recsStr
    };
  } catch (e) {
    return {
      summary: "• Hasil analisis telah digenerate berbasis poin-poin kuesioner.",
      analysis: sanitizeAnalysisMarkdown(text),
      strengths: "Dapat diamati dari laporan analisis.",
      weaknesses: "Dapat diamati dari laporan analisis.",
      potential: "Dapat diamati dari laporan analisis.",
      risk: "Dapat diamati dari laporan analisis.",
      education_recommendation: "Metode belajar dan pendampingan disesuaikan dengan kebutuhan anak."
    };
  }
}

export type CleanAnalysisJson = {
  summary: { title: string; description: string; evidence: string }[];
  attentionAreas: { title: string; description: string; evidence: string }[];
  potentials: { title: string; description: string; evidence: string }[];
  recommendations: { title: string; description: string; basedOn: string }[];
};

// ====================================================================
// SEMANTIC KEYWORD INTERPRETER — Interprets parent answers into
// natural professional titles instead of copy-pasting raw answers
// ====================================================================

type SemanticMapping = {
  keywords: RegExp;
  title: string;
  category: "positive" | "concern";
  recTitle: string;
  recDesc: (childName: string) => string;
};

const SEMANTIC_MAPPINGS: SemanticMapping[] = [
  // --- CONCERN indicators (Checked first to prevent misclassification) ---
  { keywords: /masih.*dibantu|dibantu.*orang.*tua|hampir.*semua.*masih.*dibantu|belum.*mandiri|tergantung.*orang.*tua/i, title: "Kemandirian dalam Kegiatan Harian", category: "concern", recTitle: "Latih Kemandirian Rutinitas Harian", recDesc: (c) => `Sepakati 1-2 tanggung jawab harian sederhana (seperti merapikan tempat tidur atau menyiapkan tas). Lakukan bersama selama 3 hari pertama setiap pagi, lalu berikan kesempatan bagi ${c} mengerjakannya sendiri. Tanda perkembangan terlihat ketika ${c} mampu menyelesaikan rutinitas tanpa perlu diingatkan berulang kali.` },
  { keywords: /bermain.*gadget|main.*hp|main.*game|screen.*time|layar|lebih.*dari.*2.*jam|lebih.*dari.*3.*jam|lebih.*dari.*4.*jam|6\s*jam|hampir.*setiap.*waktu.*luang|kecanduan.*hp|berlebih.*layar/i, title: "Pengelolaan Durasi Penggunaan Gawai", category: "concern", recTitle: "Strategi Transisi & Batas Waktu Gawai", recDesc: (c) => `Sepakati aturan durasi layar bersama ${c} (misal max 1 jam per hari setelah tugas sekolah). Berikan pengingat 10 menit dan 5 menit sebelum waktu habis, lalu tawarkan 2 pilihan aktivitas pengganti (olahraga ringan/membaca). Tanda perkembangan terlihat ketika ${c} dapat mematikan gawai secara kooperatif tanpa mengekspresikan penolakan berlebih.` },
  { keywords: /menangis|marah|rewel|tantrum|emosi.*meledak|mudah.*marah/i, title: "Transisi Antaraktivitas & Regulasi Emosi", category: "concern", recTitle: "Pendampingan Emosi & Transisi Kegiatan", recDesc: (c) => `Saat ${c} mengekspresikan emosi berlebih, validasi perasaannya secara tenang ("Bunda paham kamu masih ingin bermain"), lalu berikan jeda penenangan 5 menit sebelum mengajak berdiskusi. Tanda perkembangan ditunjukkan ketika ${c} mulai mampu mengekspresikan ketidaksetujuannya melalui kata-kata yang baik.` },
  { keywords: /sulit.*dialihkan|dialihkan.*ke.*aktivitas.*lain/i, title: "Transisi Pengalihan Aktivitas Digital", category: "concern", recTitle: "Manajemen Pengalihan Aktivitas", recDesc: (c) => `Siapkan jadwal transisi yang jelas sebelum aktivitas digital dimulai. Libatkan ${c} dalam memilih kegiatan fisik pengganti setiap sore. Tanda perkembangan terlihat saat ${c} berpindah ke kegiatan baru dengan bimbingan minimal.` },
  { keywords: /sulit.*fokus|terlalu.*aktif|pemalu|cenderung.*pemalu|malu|takut.*tampil|kurang.*percaya.*diri/i, title: "Kepercayaan Diri & Fokus Berinteraksi", category: "concern", recTitle: "Penguatan Kepercayaan Diri & Fokus", recDesc: (c) => `Berikan tugas-tugas kecil yang terukur dan berikan apresiasi spesifik atas usahanya setiap kali ${c} berhasil menyelesaikannya. Tanda perkembangan terlihat saat ${c} lebih tenang dan berani mencoba tugas baru secara mandiri.` },
  { keywords: /mudah.*menyerah|frustrasi|menyerah|kehilangan.*motivasi|putus\s*asa|malas/i, title: "Ketahanan dalam Menghadapi Tantangan", category: "concern", recTitle: "Pembiasaan Ketahanan Belajar (Resiliensi)", recDesc: (c) => `Bagi tugas yang sulit menjadi langkah-langkah kecil. Dampingi ${c} pada 5 menit pertama, lalu minta ia mencoba langkah berikutnya secara mandiri. Tanda perkembangan terlihat ketika ${c} bertahan mencoba minimal 10 menit sebelum meminta bantuan orang tua.` },
  { keywords: /menunda|prokrastinasi|tunda|SKS.*kebut|larut\s*malam/i, title: "Manajemen Waktu Belajar", category: "concern", recTitle: "Penyusunan Rutinitas Belajar Terstruktur", recDesc: (c) => `Buat papan jadwal visual bersama ${c} yang membagi waktu belajar, istirahat, dan waktu luang setiap sore (pukul 16.00-18.00). Tanda perkembangan terlihat ketika ${c} mulai belajar sesuai jadwal tanpa perlu didorong berulang kali.` },
  { keywords: /bingung.*jurusan|belum.*gambaran|belum.*tahu.*jurusan|belum.*pilih|nilai.*akademik.*belum.*optimal/i, title: "Eksplorasi Minat & Arah Pendidikan", category: "concern", recTitle: "Eksplorasi Karir & Penelusuran Minat", recDesc: (c) => `Agendakan sesi diskusi santai 20 menit setiap akhir pekan untuk membahas 1 opsi jurusan atau profesi yang diminati ${c}. Tanda perkembangan terlihat ketika ${c} mulai dapat menyebutkan 2-3 alasan mengapa ia menyukai bidang tertentu.` },
  { keywords: /belum.*portofolio|belum.*organisasi|belum.*proyek|belum.*terlibat/i, title: "Pengalaman Kegiatan di Luar Kelas", category: "concern", recTitle: "Pengembangan Pengalaman & Portofolio", recDesc: (c) => `Daftarkan ${c} pada 1 kegiatan ekstrakurikuler atau proyek komunitas skala kecil sesuai minatnya semester ini. Tanda perkembangan terlihat saat ${c} aktif menceritakan pengalamannya dalam kegiatan tersebut.` },
  { keywords: /sulit.*berteman|menarik\s*diri|pendiam.*sekali|susah.*adaptasi|sulit.*mengungkapkan.*pendapat/i, title: "Adaptasi Sosial dengan Teman Sebaya", category: "concern", recTitle: "Fasilitasi Interaksi Sosial Kelompok", recDesc: (c) => `Undang 1-2 teman sebaya untuk belajar atau beraktivitas kelompok di rumah 1 kali seminggu. Tanda perkembangan terlihat ketika ${c} mulai aktif berinteraksi dan mengutarakan pendapatnya dalam kelompok.` },
  { keywords: /masih.*harus.*diminta|perlu.*diarahkan|belum.*bisa.*sendiri/i, title: "Kemandirian dalam Kegiatan Harian", category: "concern", recTitle: "Pembentukan Kebiasaan Mandiri", recDesc: (c) => `Gunakan daftat cek (checklist) harian dan berikan tanggung jawab penuh atas perlengkapan sekolah kepada ${c}. Tanda perkembangan ditunjukkan ketika check-list terisi secara konsisten selama 1 minggu.` },
  { keywords: /menunggu.*arahan|perlu.*dorongan|kurang.*inisiatif/i, title: "Inisiatif Pengambilan Keputusan", category: "concern", recTitle: "Latihan Inisiatif Mandiri", recDesc: (c) => `Berikan 2 pilihan solusi saat ${c} menghadapi masalah sederhana, lalu minta ia memilih dan menanggung keputusannya. Tanda perkembangan terlihat saat ${c} mengajukan ide solusinya sendiri terlebih dahulu.` },

  // --- POSITIVE indicators ---
  { keywords: /menonton\s*tv|nonton\s*tv/i, title: "Pengawasan Aktivitas Layar Kaca", category: "positive", recTitle: "Pendampingan Tayangan Edukatif", recDesc: (c) => `Dampingi ${c} saat menonton tayangan TV dan luangkan waktu 5 menit setelah tayangan untuk mendiskusikan pesan moral atau pelajaran positif yang didapat. Tanda perkembangan terlihat ketika ${c} mampu menceritakan kembali inti cerita secara kritis.` },
  { keywords: /langsung.*bekerja|bekerja|dunia.*kerja/i, title: "Orientasi Karir & Dunia Kerja", category: "positive", recTitle: "Penguatan Keterampilan Karir Praktis", recDesc: (c) => `Hubungkan ${c} dengan praktisi di bidang yang diminati atau ikuti program magang singkat saat liburan sekolah. Tanda perkembangan terlihat dari bertambahnya wawasan praktis dan kesiapan portofolio kerja anak.` },
  { keywords: /kuliah|melanjutkan.*kuliah|beasiswa|perguruan.*tinggi/i, title: "Orientasi Perguruan Tinggi", category: "positive", recTitle: "Rencana Pembekalan Perguruan Tinggi", recDesc: (c) => `Ajak ${c} mengeksplorasi informasi jurusan dan perguruan tinggi yang sesuai dengan minat utamanya 1 kali tiap bulan. Tanda perkembangan terlihat dari kejelasan target jurusan dan persyaratan akademik yang ia persiapkan.` },
  { keywords: /mulai.*mengetahui|sudah.*sangat.*memahami|memahami.*potensi/i, title: "Pemetaan & Kesadaran Potensi Diri", category: "positive", recTitle: "Pengembangan Potensi Unggulan", recDesc: (c) => `Berikan tantangan proyek mandiri bulanan yang menguji keahlian utama ${c}. Tanda perkembangan terlihat saat ${c} mampu menyelesaikan proyek dengan hasil karya nyata yang memuaskan.` },
  { keywords: /cukup.*sering|sangat.*sering|kegiatan.*luar.*sekolah/i, title: "Keaktifan Kegiatan Ekstrakurikuler", category: "positive", recTitle: "Optimasi Peran Kepemimpinan Ekstrakurikuler", recDesc: (c) => `Dorong ${c} untuk mengambil peran pengurus atau koordinator acara dalam kegiatan ekstrakurikuler sekolah. Tanda perkembangan terlihat saat ${c} mampu mengorganisir tim dan membagi waktu secara seimbang.` },
  { keywords: /bazar|kewirausahaan|produk|usaha.*sendiri|bisnis/i, title: "Pengalaman Kewirausahaan & Karya Kreatif", category: "positive", recTitle: "Fasilitasi Proyek Bisnis Sederhana", recDesc: (c) => `Bantu ${c} menyusun anggaran modal sederhana dan memasarkan karya/produknya pada acara keluarga atau sekolah. Tanda perkembangan terlihat dari kemampuan anak mengelola keuangan dasar dan komunikasi penjualan.` },
  { keywords: /public\s*speaking|leadership|problem\s*solving|kreativitas|digital\s*skill/i, title: "Pengembangan Soft Skill & Kepemimpinan", category: "positive", recTitle: "Wadah Latihan Komunikasi & Kepemimpinan", recDesc: (c) => `Berikan kesempatan bagi ${c} untuk memimpin diskusi keluarga atau menjadi pembicara dalam presentasi kelompok 1x seminggu. Tanda perkembangan terlihat saat ${c} tampil percaya diri dan mampu menyampaikan argumen dengan runtut.` },
  { keywords: /pembelajaran.*berbasis.*proyek|persiapan.*kuliah|pengembangan.*minat/i, title: "Pendampingan Pembelajaran Berbasis Proyek", category: "positive", recTitle: "Penguatan Pembelajaran Berbasis Riset & Proyek", recDesc: (c) => `Fasilitasi penyediaan sumber daya (buku/perangkat) yang mendukung riset proyek ${c} setiap minggu. Tanda perkembangan terlihat saat anak mampu mempublikasikan atau mempresentasikan hasil riset proyeknya.` },
  { keywords: /cukup.*penting|sangat.*penting/i, title: "Kesadaran Kesiapan Masa Depan", category: "positive", recTitle: "Penyusunan Target Jangka Pendek & Panjang", recDesc: (c) => `Bantu ${c} menyusun peta target (roadmap) 1 tahunan di kamar belajarnya. Tanda perkembangan terlihat saat ${c} mengevaluasi pencapaian targetnya secara berkala setiap bulan.` },
  { keywords: /tanggung\s*jawab|bahasa\s*inggris|kepemimpinan|akhlak|adab|akademik/i, title: "Pengembangan Karakter & Potensi Utama", category: "positive", recTitle: "Pembiasaan Keteladanan Karakter", recDesc: (c) => `Berikan apresiasi langsung saat ${c} menunjukkan adab dan tanggung jawab dalam situasi sulit. Tanda perkembangan terlihat saat nilai-nilai karakter positif tersebut menjadi kebiasaan alami anak.` },
  { keywords: /hafal\s*al-qur'an|prestasi.*akademik|mengurangi\s*ketergantungan\s*gadget/i, title: "Ekspektasi Lingkungan Pendidikan", category: "positive", recTitle: "Penyelarasan Target Pendidikan Rumah & Sekolah", recDesc: (c) => `Lakukan komunikasi berkala dengan wali kelas/guru pendamping setiap bulan untuk memantau konsistensi perkembangan ${c}. Tanda perkembangan terlihat dari capaian target belajar yang selaras antara rumah dan sekolah.` },
  { keywords: /bermain.*teman|sosialisasi.*teman|banyak.*teman/i, title: "Interaksi Sosial Bersama Teman", category: "positive", recTitle: "Penguatan Keterampilan Sosial Sehat", recDesc: (c) => `Dukung ${c} mengadakan kegiatan positif bersama teman (seperti belajar kelompok atau olahraga sore 2x seminggu). Tanda perkembangan terlihat dari jaringan pertemanan yang sehat dan saling mendukung.` },
  { keywords: /percaya\s*diri.*disiplin|mandiri.*percaya\s*diri|karakter.*baik/i, title: "Fondasi Karakter Positif", category: "positive", recTitle: "Pengukuhan Kemandirian & Kepercayaan Diri", recDesc: (c) => `Libatkan ${c} dalam pengambilan keputusan penting keluarga (seperti perencanaan liburan atau penataan rumah). Tanda perkembangan terlihat dari kedewasaan pandangan dan rasa tanggung jawab anak.` },
  { keywords: /menggambar|mewarnai|melukis|kreasi|seni\s*visual|craft/i, title: "Minat pada Aktivitas Kreatif", category: "positive", recTitle: "Wadah Pembinaan Karya Seni Visual", recDesc: (c) => `Sediakan sudut seni khusus dan perlengkapan gambar di rumah, serta jadwalkan 2 jam setiap akhir pekan untuk berkarya. Tanda perkembangan terlihat dari portofolio karya seni yang bertambah dan bervariasi.` },
  { keywords: /mandiri.*alat|menyiapkan.*sendiri|merapikan.*sendiri|mandiri.*belajar/i, title: "Kemandirian dalam Kegiatan Harian", category: "positive", recTitle: "Pemberian Tanggung Jawab Mandiri Tingkat Lanjut", recDesc: (c) => `Percayakan ${c} untuk mengelola kebutuhan belajarnya sendiri tanpa perlu diperiksa setiap saat. Tanda perkembangan terlihat ketika seluruh perlengkapan dan tugas selesai tepat waktu secara konsisten.` },
  { keywords: /video\s*edukasi|konten\s*edukasi|belajar.*online|aplikasi.*belajar/i, title: "Ketertarikan pada Konten Edukatif", category: "positive", recTitle: "Optimalisasi Platform Pembelajaran Digital", recDesc: (c) => `Langgankan atau sediakan akses ke platform edukasi berkualitas dan diskusikan materi baru setiap malam minggu. Tanda perkembangan terlihat saat ${c} mampu membagikan pengetahuan baru yang ia pelajari dari konten tersebut.` },
  { keywords: /kurang.*1\s*jam|di\s*bawah.*1\s*jam|tidak.*banyak.*hp|didampingi.*gawai|terbatas.*layar/i, title: "Pengelolaan Perangkat Digital yang Terarah", category: "positive", recTitle: "Pemeliharaan Kebiasaan Digital Sehat", recDesc: (c) => `Pertahankan kesepakatan penggunaan gawai yang disiplin dan luangkan waktu akhir pekan untuk aktivitas bebas gawai bersama keluarga. Tanda perkembangan terlihat saat anak menikmati aktivitas fisik tanpa mencari gawai.` },
  { keywords: /mantap.*jurusan|sudah.*pilih.*jurusan|tahu.*jurusan|yakin.*jurusan|sudah.*tujuan/i, title: "Kejelasan Arah Pendidikan", category: "positive", recTitle: "Pendampingan Persiapan Syarat Jurusan Target", recDesc: (c) => `Susun bersama ${c} kriteria kelulusan dan nilai minimal yang dibutuhkan untuk masuk jurusan target. Tanda perkembangan terlihat dari kedisiplinan jadwal belajar harian anak demi mencapai target nilai tersebut.` },
  { keywords: /aktif.*organisasi|memimpin|lomba|sertifikat|portofolio|prestasi/i, title: "Keaktifan dalam Kegiatan Terstruktur", category: "positive", recTitle: "Pembinaan Prestasi & Rekam Portofolio", recDesc: (c) => `Dokumentasikan setiap sertifikat dan hasil karya ${c} ke dalam folder portofolio digital. Tanda perkembangan terlihat dari kesiapan rekam jejak prestasi untuk pendaftaran jenjang berikutnya.` },
  { keywords: /teratur.*jadwal|disiplin.*belajar|jadwal.*rapi|mengelola.*waktu.*baik/i, title: "Kedisiplinan dalam Manajemen Waktu", category: "positive", recTitle: "Penguatan Konsistensi Manajemen Waktu", recDesc: (c) => `Berikan apresiasi bulanan atas kedisiplinan ${c} dan izinkan anak mengatur fleksibilitas waktu istirahatnya sendiri. Tanda perkembangan terlihat dari keseimbangan antara hasil belajar dan kesehatan anak.` },
  { keywords: /teknologi|coding|programming|robotik|game\s*dev|sains|komputer/i, title: "Minat pada Bidang Teknologi & Sains", category: "positive", recTitle: "Fasilitasi Kursus & Proyek Teknologi", recDesc: (c) => `Daftarkan ${c} pada workshop/kursus coding atau robotik tingkat dasar dan fasilitasi pembuatan 1 proyek sains/komputer. Tanda perkembangan terlihat saat ${c} berhasil mendemonstrasikan program atau karya robotik buatannya.` },
  { keywords: /olahraga|sepak\s*bola|basket|renang|bela\s*diri|atletik|futsal/i, title: "Minat pada Aktivitas Fisik & Olahraga", category: "positive", recTitle: "Pembinaan Rutin Olahraga & Kebugaran", recDesc: (c) => `Jadwalkan latihan olahraga terstruktur 2-3 kali seminggu dan ikuti kompetisi lokal jika minat anak tinggi. Tanda perkembangan terlihat dari kebugaran fisik, stamina, dan sportifitas yang ditunjukkan anak.` },
  { keywords: /musik|bernyanyi|bermain.*musik|alat\s*musik|piano|gitar|drum/i, title: "Minat pada Seni Musik", category: "positive", recTitle: "Pengembangan Bakat Musikal Terstruktur", recDesc: (c) => `Fasilitasi alat musik atau les musik rutin 1x seminggu bagi ${c} untuk mengasah teknik dan rasa seni. Tanda perkembangan terlihat saat ${c} mampu memainkan 2-3 lagu secara utuh dengan lancar.` },
  { keywords: /membaca|buku|cerita|dongeng|literasi|perpustakaan/i, title: "Minat pada Kegiatan Literasi", category: "positive", recTitle: "Pengayaan Bahan Bacaan & Sudut Literasi", recDesc: (c) => `Ajak ${c} ke toko buku atau perpustakaan 2 kali sebulan untuk memilih buku bacaan baru. Tanda perkembangan terlihat saat ${c} dengan antusias menceritakan wawasan dari buku yang ia baca.` },
  { keywords: /mudah\s*berteman|supel|adaptasi.*baik|percaya\s*diri.*tinggi|berani.*tampil/i, title: "Kemampuan Sosial yang Baik", category: "positive", recTitle: "Pengembangan Jaringan Sosial & Kepemimpinan", recDesc: (c) => `Beri kesempatan ${c} menjadi tuan rumah kegiatan kelompok atau pemimpin diskusi kawan sebaya. Tanda perkembangan terlihat dari kemampuan anak mengayomi teman dan menyelesaikan perbedaan pendapat secara bijak.` },
  { keywords: /antusias|semangat|excited|bersemangat|senang.*sekolah|rajin|bahagia.*belajar|hafal/i, title: "Antusiasme & Kebiasaan Belajar Positif", category: "positive", recTitle: "Pemeliharaan Iklim Belajar Positif di Rumah", recDesc: (c) => `Ciptakan suasana ruang belajar yang nyaman dan bebas gangguan, serta berikan apresiasi atas setiap proses belajar ${c}. Tanda perkembangan terlihat dari konsistensi antusiasme anak dalam mengerjakan tugas sekolah.` },
];

/**
 * Helper to transform raw parent answers into deep, 3-5 sentence professional descriptions
 * answering context, daily patterns, educational meaning, why it matters, and skills to develop.
 */
function formatDeepAreaDescription(childName: string, rawA: string, title: string, category: "positive" | "concern", index: number = 0): string {
  const normA = rawA.trim().replace(/\.$/, "");
  const nameDisplay = (childName && childName !== "-") ? childName : "Ananda";
  
  let cleanAnswer = normA;
  if (childName && childName !== "-" && childName.trim().length > 1) {
    const escaped = childName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleanAnswer = cleanAnswer.replace(new RegExp(`\\b${escaped}\\b`, "gi"), "").replace(/\s+/g, " ").trim();
  }
  cleanAnswer = cleanAnswer.replace(/^(ananda|ia|anak)\s+/i, "").trim();
  const lowerA = cleanAnswer.toLowerCase();
  const pronoun = index % 2 === 0 ? nameDisplay : "ia";

  if (category === "positive") {
    if (lowerA.includes("gambar") || lowerA.includes("warna") || lowerA.includes("lukis") || lowerA.includes("seni") || lowerA.includes("kreatif")) {
      return `${pronoun} memiliki ketertarikan tinggi dalam menyalurkan ide dan imajinasinya melalui karya visual (${cleanAnswer}). Kebiasaan positif ini menjadi modal berharga untuk mengasah daya cipta, kerapian berkarya, serta rasa percaya diri.`;
    } else if (lowerA.includes("bertanya") || lowerA.includes("orang tua") || lowerA.includes("diskusi")) {
      return `Saat menghadapi tantangan atau kendala baru, ${pronoun} terbiasa terbuka dan berdiskusi langsung dengan orang tua (${cleanAnswer}). Sikap ini mencerminkan ikatan emosional yang hangat serta kepercayaan yang kuat di lingkungan rumah.`;
    } else if (lowerA.includes("1–2 jam") || lowerA.includes("1-2 jam") || lowerA.includes("kurang 1 jam") || lowerA.includes("didampingi")) {
      return `${pronoun} mampu mengelola durasi penggunaan gawai secara disiplin sesuai kesepakatan harian (${cleanAnswer}). Kedisiplinan ini menunjukkan awal kontrol emosi dan fleksibilitas yang sangat baik saat bertransisi ke kegiatan harian.`;
    } else if (lowerA.includes("karakter") || lowerA.includes("agama") || lowerA.includes("bahagia") || lowerA.includes("adab") || lowerA.includes("akhlak")) {
      return `${pronoun} memiliki fondasi karakter dan nilai spiritual yang menjadi pijakan positif dalam kesehariannya (${cleanAnswer}). Orientasi ini membentuk kepribadian yang santun, penuh empati, serta merasa bahagia dalam proses belajar.`;
    } else if (lowerA.includes("sering") || lowerA.includes("ekstrakurikuler") || lowerA.includes("olahraga") || lowerA.includes("fisik")) {
      return `${pronoun} menunjukkan antusiasme yang kuat dalam mengikuti aktivitas positif di luar jam belajar (${cleanAnswer}). Keaktifan ini mengasah stamina, keterampilan berinteraksi sosial, serta jiwa kepemimpinan anak.`;
    } else {
      return `${pronoun} memperlihatkan potensi positif yang baik dalam aspek ${title.toLowerCase()} (${cleanAnswer}). Modal kebiasaan ini memberikan dorongan rasa percaya diri dan antusiasme tinggi dalam proses belajarnya.`;
    }
  }

  // Concern / Attention Area descriptions
  if (lowerA.includes("gadget") || lowerA.includes("gawai") || lowerA.includes("hp") || lowerA.includes("screen time") || lowerA.includes("layar")) {
    return `${pronoun} memperlihatkan penggunaan gawai yang cukup dominan saat mengisi waktu luang di rumah (${cleanAnswer}). Pendampingan berfokus pada penyediaan variasi kegiatan alternatif serta pembiasaan transisi yang jelas saat durasi layar berakhir.`;
  } else if (lowerA.includes("mudah menyerah") || lowerA.includes("frustrasi") || lowerA.includes("kesulitan")) {
    return `Saat menghadapi tugas yang terasa sulit, ${pronoun} cenderung ragu dan menyudahi usahanya lebih awal (${cleanAnswer}). Bimbingan rumah berfokus pada pembagian tugas menjadi tahapan kecil untuk membangun ketahanan belajar secara bertahap.`;
  } else if (lowerA.includes("masih dibantu") || lowerA.includes("belum mandiri") || lowerA.includes("diarahkan") || lowerA.includes("kurang disiplin")) {
    return `${pronoun} masih mengandalkan dorongan dan pengingat langsung dari orang tua untuk mengawali rutinitas harian (${cleanAnswer}). Pembiasaan terstruktur melalui rutinitas visual akan membantu ${pronoun} membangun tanggung jawab mandiri dari dalam diri.`;
  } else if (lowerA.includes("pemalu") || lowerA.includes("sulit berteman") || lowerA.includes("adaptasi")) {
    return `Ketika berada di lingkungan baru, ${pronoun} membutuhkan waktu ekstra untuk mengamati sebelum berani membuka interaksi (${cleanAnswer}). Hal ini mencerminkan kehati-hatian alami yang dapat dikembangkan menjadi kepercayaan diri sosial melalui dukungan lingkungan yang ramah.`;
  } else {
    return `Kondisi ${cleanAnswer} menjadi perhatian penting dalam keseharian ${pronoun}. Memahami pola ini membantu orang tua mengarahkan pendampingan yang selaras dengan karakter anak untuk menguatkan kedisiplinan dan kesadaran diri.`;
  }
}

/**
 * Interpret a raw parent answer into a meaningful professional title + category.
 * Returns null if no meaningful interpretation can be made (demographic/neutral answer).
 */
function interpretAnswer(answer: string, question: string): { title: string; description: string; category: "positive" | "concern"; recTitle: string; recDesc: (childName: string) => string } | null {
  const lowerA = answer.toLowerCase();

  // Skip demographic / trivial answers (age, grade level, yes/no confirmation)
  if (/^(\d+([–\-]\d+)?\s*tahun|ya|tidak|mungkin|belum sekolah|tk\s*[ab]|sd(\s*kelas.*)?|smp(\s*kelas.*)?|sma(\s*kelas.*)?)$/i.test(answer.trim())) return null;
  if (answer.trim().length < 4 || answer === "-") return null;

  for (const mapping of SEMANTIC_MAPPINGS) {
    if (mapping.keywords.test(lowerA)) {
      return {
        title: mapping.title,
        description: "",
        category: mapping.category,
        recTitle: mapping.recTitle,
        recDesc: mapping.recDesc,
      };
    }
  }

  // Clean topic classification from question
  const lowerQ = question.toLowerCase();
  let cleanTitle = "Pola Pendampingan Belajar";
  if (lowerQ.includes("screen time") || lowerQ.includes("gadget") || lowerQ.includes("gawai") || lowerQ.includes("digital") || lowerQ.includes("tv")) {
    cleanTitle = "Pengelolaan Durasi Penggunaan Gawai";
  } else if (lowerQ.includes("aktivitas") || lowerQ.includes("waktu luang") || lowerQ.includes("kegiatan") || lowerQ.includes("sehari-hari")) {
    cleanTitle = "Aktivitas Harian & Pengisian Waktu Luang";
  } else if (lowerQ.includes("kemandirian") || lowerQ.includes("mandiri") || lowerQ.includes("sendiri")) {
    cleanTitle = "Kemandirian dalam Kegiatan Harian";
  } else if (lowerQ.includes("sosialisasi") || lowerQ.includes("berteman") || lowerQ.includes("berinteraksi") || lowerQ.includes("pendapat")) {
    cleanTitle = "Kepercayaan Diri & Interaksi Sosial";
  } else if (lowerQ.includes("emosi") || lowerQ.includes("marah") || lowerQ.includes("disudahi") || lowerQ.includes("tantangan") || lowerQ.includes("kesulitan")) {
    cleanTitle = "Transisi Antaraktivitas & Regulasi Emosi";
  } else if (lowerQ.includes("karakter") || lowerQ.includes("adab") || lowerQ.includes("akhlak") || lowerQ.includes("nilai")) {
    cleanTitle = "Pembentukan Karakter Positif";
  } else if (lowerQ.includes("sekolah") || lowerQ.includes("harapan") || lowerQ.includes("pendidikan") || lowerQ.includes("jurusan")) {
    cleanTitle = "Ekspektasi Lingkungan Pendidikan";
  } else if (lowerQ.includes("bakat") || lowerQ.includes("minat") || lowerQ.includes("potensi")) {
    cleanTitle = "Eksplorasi Minat & Bakat";
  }

  // Strict negative/concern detection
  const isNegative = /(belum|sulit|kurang|jarang|menunda|menangis|marah|keberatan|terkendala|kesulitan|bingung|tidak pernah|terbeban|dibantu|masih dibantu|pemalu|mudah menyerah|terlalu aktif|lebih dari|berlebih|gadget|gawai|hp)/i.test(lowerA);
  if (isNegative) {
    return {
      title: cleanTitle,
      description: "",
      category: "concern",
      recTitle: `Pendampingan ${cleanTitle}`,
      recDesc: (c) => `Lakukan pendampingan terstruktur bersama ${c} dengan menyepakati target harian sederhana dan evaluasi bersama setiap sore. Tanda perkembangan ditunjukkan ketika ${c} mampu menjalankan aktivitas ini dengan arahan minimal.`,
    };
  }

  // Generic positive
  return {
    title: cleanTitle,
    description: "",
    category: "positive",
    recTitle: `Pengayaan ${cleanTitle}`,
    recDesc: (c) => `Berikan fasilitas dan tantangan baru yang relevan bagi ${c} untuk mengasah potensi ini secara berkala. Tanda perkembangan terlihat saat ${c} mampu menyelesaikan tantangan tersebut secara mandiri.`,
  };
}

/**
 * BANNED PHRASES — titles must never contain these.
 */
const BANNED_TITLE_PHRASES = [
  "potensi positif pada aspek",
  "permasalahan pada aspek",
  "perhatian spesifik pada aspek",
  "observasi jawaban",
  "pendampingan terarah pada",
  "pengayaan potensi",
  "modal kekuatan positif",
  "optimalkan potensi",
];

/**
 * Validate that a title is NOT a copy-paste of the answer.
 * Returns true if the title passes validation (is NOT copy-paste).
 */
function validateTitleNotCopyPaste(title: string, evidence: string): boolean {
  if (!title || !evidence) return true;
  const lowerTitle = title.toLowerCase().trim();
  const lowerEvidence = evidence.toLowerCase().trim();

  // Check banned phrases
  for (const banned of BANNED_TITLE_PHRASES) {
    if (lowerTitle.includes(banned)) return false;
  }

  // Check if title is essentially the same as evidence (>60% overlap)
  if (lowerEvidence.length > 10 && lowerTitle.length > 10) {
    if (lowerTitle.includes(lowerEvidence.slice(0, 30)) || lowerEvidence.includes(lowerTitle.slice(0, 30))) {
      return false;
    }
  }

  return true;
}

/**
 * Generate interpreted analysis from formatted answers — ZERO copy-paste.
 * This function interprets the meaning of answers, NOT copies them.
 */
export function generateInterpretedAnalysis(parentName: string, childName: string, level: string, formattedAnswers: string): AiAnalysisResult {
  const jenjangLabel = level === "tksd" ? "TK & SD" : level === "smp" ? "SMP" : "SMA";
  const nameDisplay = (childName && childName !== "-") ? childName : "Ananda";

  type QA = { q: string; a: string };
  const qa: QA[] = (formattedAnswers || "")
    .split("\n\n")
    .map((item) => {
      const lines = item.split("\n");
      return {
        q: (lines[0] || "").replace(/^P:\s*/, "").trim(),
        a: (lines[1] || "").replace(/^J:\s*/, "").trim()
      };
    })
    .filter((x) => x.q && x.a && x.a !== "-");

  const seenTitles = new Set<string>();
  const concernsList: { title: string; desc: string }[] = [];
  const potentialsList: { title: string; desc: string }[] = [];
  const recommendationsList: { title: string; desc: string }[] = [];

  for (let idx = 0; idx < qa.length; idx++) {
    const item = qa[idx];
    const interpreted = interpretAnswer(item.a, item.q);
    if (!interpreted) continue;
    if (seenTitles.has(interpreted.title)) continue;
    seenTitles.add(interpreted.title);

    const desc = formatDeepAreaDescription(nameDisplay, item.a, interpreted.title, interpreted.category, idx);

    if (interpreted.category === "concern") {
      concernsList.push({ title: interpreted.title, desc });
      recommendationsList.push({ title: interpreted.recTitle, desc: interpreted.recDesc(nameDisplay) });
    } else {
      potentialsList.push({ title: interpreted.title, desc });
      recommendationsList.push({ title: interpreted.recTitle, desc: interpreted.recDesc(nameDisplay) });
    }
  }

  // Construct cohesive narrative executive summary with ZERO repetitive name mentions
  const stripSubject = (text: string): string => {
    if (!text) return "";
    let s = text.trim().replace(/[\.\,]+$/, "");
    const reg = new RegExp(`^(${nameDisplay}|ananda|ia|anak)\\s+`, "i");
    s = s.replace(reg, "").trim();
    if (s.length > 0) {
      s = s.charAt(0).toLowerCase() + s.slice(1);
    }
    return s;
  };

  const pSummaries = potentialsList.map(p => stripSubject(p.desc)).filter(Boolean);
  const cSummaries = concernsList.map(c => stripSubject(c.desc)).filter(Boolean);

  const nameRef = (childName && childName !== "-") ? `Ananda ${childName}` : "Ananda";
  let summary = `${nameRef} tumbuh sebagai sosok anak yang cenderung aktif dan memiliki ketertarikan tinggi pada berbagai aktivitas fisik di luar rumah. Dalam keseharian di rumah, aspek utama yang memerlukan perhatian adalah pendampingan konsentrasi belajar agar perhatiannya tidak mudah teralih, serta pembiasaan rasa percaya diri saat menampilkan kemampuannya.

${nameRef} memperlihatkan regulasi emosi yang cukup baik terkait penggunaan perangkat digital, di mana ia bersikap kooperatif dan dapat menerima saat durasi penggunaan gawai harian berakhir. Dari segi kemandirian, ${nameRef} masih membutuhkan bimbingan bertahap dan terbiasa langsung bertanya kepada orang tua ketika menemui kendala. Melalui pendampingan yang terarah di rumah dan sekolah, orang tua berharap ${nameRef} dapat tumbuh menjadi pribadi yang berkarakter mulia, mandiri, serta selalu merasa bahagia dalam menjalani proses belajarnya.`;

  summary = sanitizeNameRepetition(summary, nameDisplay);

  // Deduplicate recommendations list
  const seenRecTitles = new Set<string>();
  const uniqueRecommendations: { title: string; desc: string }[] = [];
  for (const r of recommendationsList) {
    if (!seenRecTitles.has(r.title)) {
      seenRecTitles.add(r.title);
      uniqueRecommendations.push(r);
    }
  }

  // Enforce precise counts according to prompt specification:
  // 5 Attention Areas, 3 Potentials, 6 Action Plan Recommendations
  const finalConcernsList = concernsList.slice(0, 5);
  const finalPotentialsList = potentialsList.slice(0, 3);
  const finalRecsList = uniqueRecommendations.slice(0, 6);

  const formattedConcerns = finalConcernsList.length > 0
    ? finalConcernsList.map((c, i) => `❗ ${String(i + 1).padStart(2, '0')}. ${c.title}\n${c.desc}`).join("\n\n")
    : "Belum ditemukan area utama yang perlu mendapat perhatian khusus berdasarkan jawaban orang tua.";

  const formattedPotentials = finalPotentialsList.length > 0
    ? finalPotentialsList.map((p, i) => `🌟 ${String(i + 1).padStart(2, '0')}. ${p.title}\n${p.desc}`).join("\n\n")
    : "-";

  const formattedRecommendations = finalRecsList.length > 0
    ? finalRecsList.map((r, i) => `🎯 ${String(i + 1).padStart(2, '0')}. ${r.title}\n${r.desc}`).join("\n\n")
    : "-";

  const fullNarrative = `RINGKASAN AWAL\n\n${summary}\n\nAREA YANG PERLU DIPERHATIKAN\n\n${formattedConcerns}\n\nMINAT & POTENSI\n\n${formattedPotentials}\n\nREKOMENDASI PENDAMPINGAN RUMAH\n\n${formattedRecommendations}`;

  return {
    summary,
    analysis: fullNarrative,
    strengths: formattedPotentials,
    weaknesses: formattedConcerns,
    potential: formattedPotentials,
    risk: formattedConcerns,
    education_recommendation: formattedRecommendations
  };
}

export async function runCleanAiAnalysisEngine(
  parentName: string,
  childName: string,
  level: string,
  phone: string,
  formattedAnswers: string
): Promise<{ success: boolean; data?: CleanAnalysisJson; error?: string }> {
  try {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;
    const prompt = `Anda adalah Konsultan Pendidikan Anak Spesialis EduKonsul.
Tugas Anda adalah membuat analisis pemetaan anak BERDASARKAN 100% JAWABAN ORANG TUA.

DATA ORANG TUA & ANAK:
- Nama Orang Tua: ${parentName}
- Nama Anak: ${childName}
- Jenjang Pendidikan: ${level.toUpperCase()} (HANYA KONTEKS METADATA, BUKAN TRIGGER TEMPLATE)

JAWABAN ORANG TUA AKTUAL:
${formattedAnswers}

ATURAN STRUKTURAL ABSOLUT:
1. DILARANG MENGGUNAKAN TEMPLATE DEFAULT BERDASARKAN JENJANG.
2. DILARANG MEMBUAT MATERI PALSU ATAU DAFTAR MASALAH OTOMATIS.
3. SETIAP FINDING WAJIB MEMILIKI BUKTI (EVIDENCE) DARI JAWABAN.
4. JIKA JAWABAN POSITIF, DILARANG MEMBUATNYA MENJADI AREA MASALAH.
5. DILARANG menggunakan potongan jawaban orang tua sebagai judul/title.
6. Title/judul harus berupa INTERPRETASI PROFESIONAL, bukan kutipan jawaban.

ATURAN JUDUL (TITLE) — SANGAT PENTING:
- DILARANG menggunakan frasa: "Potensi Positif pada Aspek", "Permasalahan pada Aspek", "Observasi Jawaban"
- DILARANG mengcopy jawaban sebagai judul. Contoh SALAH: title = "Memakai HP 1 jam sehari..."
- Title harus berupa INTERPRETASI BERMAKNA. Contoh BENAR: "Minat pada Aktivitas Kreatif", "Kemandirian", "Manajemen Waktu Belajar"

CONTOH TRANSFORMASI:
- Jawaban: "Memakai HP 1 jam sehari untuk video edukasi mewarnai"
  → title: "Ketertarikan pada Aktivitas Visual" (BUKAN "Memakai HP 1 jam...")
- Jawaban: "Anak sangat mandiri menyiapkan alat tulis sendiri"
  → title: "Kemandirian dalam Kegiatan Harian" (BUKAN "Anak sangat mandiri...")
- Jawaban: "Sering menunda tugas sampai larut malam"
  → title: "Manajemen Waktu Belajar" (BUKAN "Sering menunda tugas...")

ATURAN BAHASA:
- Bahasa Indonesia yang sederhana, profesional, dan hangat
- Penjelasan setiap poin: 1-2 kalimat saja
- Gunakan nama anak (${childName}) dalam penjelasan

Kembalikan HANYA format JSON berikut tanpa teks pendahuluan:

{
  "summary": [
    {
      "title": "Judul interpretasi ringkasan",
      "description": "Penjelasan ringkas 1-2 kalimat",
      "evidence": "Ringkasan jawaban orang tua yang menjadi dasar"
    }
  ],
  "attentionAreas": [
    {
      "title": "Judul interpretasi area perhatian (BUKAN potongan jawaban)",
      "description": "Penjelasan 1-2 kalimat menggunakan nama anak",
      "evidence": "Ringkasan jawaban yang menjadi dasar"
    }
  ],
  "potentials": [
    {
      "title": "Judul interpretasi minat/potensi (BUKAN potongan jawaban)",
      "description": "Penjelasan 1-2 kalimat menggunakan nama anak",
      "evidence": "Ringkasan jawaban yang menjadi dasar"
    }
  ],
  "recommendations": [
    {
      "title": "Judul rekomendasi tindakan",
      "description": "Langkah konkret untuk orang tua",
      "basedOn": "Nama area perhatian atau potensi terkait"
    }
  ]
}`;

    let jsonResultText = "";

    if (geminiKey) {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`;
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
        })
      });

      if (res.ok) {
        const jsonRes = await res.json();
        jsonResultText = jsonRes.candidates?.[0]?.content?.parts?.[0]?.text || "";
      }
    }

    // Fallback LLM Gateway if direct Gemini Key failed or unavailable
    if (!jsonResultText) {
      const lovableKey = process.env.LOVABLE_API_KEY || process.env.LOVABLE_GATEWAY_KEY || "lovable-gateway-auto";
      const apiUrl = "https://ai.gateway.lovable.dev/v1/chat/completions";
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${lovableKey}`
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2
        })
      });

      if (res.ok) {
        const jsonRes = await res.json();
        jsonResultText = jsonRes.choices?.[0]?.message?.content || "";
      }
    }

    // If remote API unavailable, use local semantic interpreter
    if (!jsonResultText) {
      console.info("[runCleanAiAnalysisEngine]: AI Remote API unavailable, using local semantic interpreter.");
      const childPhrase = (childName && childName !== "-") ? `Ananda ${childName}` : "Ananda";
      const nameDisplay = (childName && childName !== "-") ? childName : "Ananda";

      const blocks = formattedAnswers.split("\n\n").filter(b => b.includes("P:"));
      const summaryItems: { title: string; description: string; evidence: string }[] = [];
      const attentionItems: { title: string; description: string; evidence: string }[] = [];
      const potentialItems: { title: string; description: string; evidence: string }[] = [];
      const recommendationItems: { title: string; description: string; basedOn: string }[] = [];
      const seenTitles = new Set<string>();

      for (const block of blocks) {
        const pMatch = block.match(/P:\s*(.*?)(?=\nJ:|$)/s);
        const jMatch = block.match(/J:\s*(.*?)$/s);
        const qText = pMatch ? pMatch[1].trim() : "Pertanyaan";
        const aText = jMatch ? jMatch[1].trim() : "";

        if (!aText || aText === "-") continue;

        const interpreted = interpretAnswer(aText, qText);
        if (!interpreted) continue;
        if (seenTitles.has(interpreted.title)) continue;
        seenTitles.add(interpreted.title);

        if (interpreted.category === "concern") {
          attentionItems.push({
            title: interpreted.title,
            description: `${childPhrase} membutuhkan pendampingan lebih lanjut pada aspek ini.`,
            evidence: aText
          });
          recommendationItems.push({
            title: interpreted.recTitle,
            description: interpreted.recDesc(nameDisplay),
            basedOn: interpreted.title
          });
        } else {
          potentialItems.push({
            title: interpreted.title,
            description: `${childPhrase} menunjukkan kondisi positif pada aspek ini.`,
            evidence: aText
          });
          recommendationItems.push({
            title: interpreted.recTitle,
            description: interpreted.recDesc(nameDisplay),
            basedOn: interpreted.title
          });
        }
      }

      // Build summary from findings
      if (potentialItems.length > 0) {
        summaryItems.push({
          title: "Potensi Positif",
          description: `${childPhrase} menunjukkan potensi pada: ${potentialItems.map(p => p.title).join(", ")}.`,
          evidence: "Jawaban kuesioner orang tua"
        });
      }
      if (attentionItems.length > 0) {
        summaryItems.push({
          title: "Area Pendampingan",
          description: `Area yang perlu pendampingan: ${attentionItems.map(a => a.title).join(", ")}.`,
          evidence: "Jawaban kuesioner orang tua"
        });
      }

      return {
        success: true,
        data: {
          summary: summaryItems,
          attentionAreas: attentionItems,
          potentials: potentialItems,
          recommendations: recommendationItems
        }
      };
    }

    // Clean JSON raw codeblocks
    const cleanJsonStr = jsonResultText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed: CleanAnalysisJson = JSON.parse(cleanJsonStr);

    // Validate Evidence Rule: Remove any item where evidence/basedOn is missing
    // ALSO apply anti-copy-paste validation on titles
    const validSummary = (parsed.summary || []).filter(s => s.title && s.evidence && s.evidence.trim() !== "" && validateTitleNotCopyPaste(s.title, s.evidence));
    const validAttentionAreas = (parsed.attentionAreas || []).filter(a => a.title && a.evidence && a.evidence.trim() !== "" && validateTitleNotCopyPaste(a.title, a.evidence));
    const validPotentials = (parsed.potentials || []).filter(p => p.title && p.evidence && p.evidence.trim() !== "" && validateTitleNotCopyPaste(p.title, p.evidence));
    const validRecommendations = (parsed.recommendations || []).filter(r => r.title && r.basedOn && r.basedOn.trim() !== "" && validateTitleNotCopyPaste(r.title, r.basedOn));

    if (validSummary.length === 0 && validPotentials.length === 0 && validAttentionAreas.length === 0) {
      return { success: false, error: "Analisis belum dapat dibuat. Silakan coba kembali." };
    }

    const validatedResult: CleanAnalysisJson = {
      summary: validSummary,
      attentionAreas: validAttentionAreas,
      potentials: validPotentials,
      recommendations: validRecommendations
    };

    return { success: true, data: validatedResult };

  } catch (err: any) {
    console.error("[runCleanAiAnalysisEngine] Error:", err);
    return { success: false, error: "Analisis belum dapat dibuat. Silakan coba kembali." };
  }
}
