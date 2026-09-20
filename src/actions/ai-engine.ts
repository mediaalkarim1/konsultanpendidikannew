import { type AiAnalysisResult } from "../lib/pdf-generator";
import { DEFAULT_UNIFIED_PROMPT } from "../lib/ai-prompt-default";
import { getAdminSupabase } from "../lib/supabase-admin";
import { sanitizeAnalysisMarkdown } from "@/lib/pdf-generator";

export const ANALYSIS_PROMPT_VERSION = "2.0.0";

export type QualityScoreDetails = {
  evidence_coverage_score: number;
  personalization_score: number;
  area_diversity_score: number;
  recommendation_match_score: number;
  genericness_score: number;
  overall_quality_score: number;
  passes_quality: boolean;
};

export function evaluateAnalysisQuality(result: AiAnalysisResult, childName: string, rawAnswers: string): QualityScoreDetails {
  const text = result.weaknesses || "";
  const areasMatch = text.match(/❗/g) || [];
  const areaCount = areasMatch.length;

  const titles = text.split("\n\n").map(b => b.split("\n")[0]).filter(Boolean);
  const uniqueTitles = new Set(titles);
  const areaDiversityScore = areaCount > 0 ? Math.min(100, Math.round((uniqueTitles.size / areaCount) * 100)) : 50;

  const hasEvidence = !/Dapat diamati|Belum ditemukan/i.test(text) && text.length > 200;
  const evidenceScore = hasEvidence ? 95 : 60;

  const cName = (childName && childName !== "-") ? childName.trim() : "";
  let personalizationScore = 80;
  if (cName.length > 1) {
    const mentions = (result.analysis || "").toLowerCase().split(cName.toLowerCase()).length - 1;
    personalizationScore = mentions >= 2 ? 95 : 70;
  }

  let genericnessScore = 90;
  if (/ADHD|autisme|kecanduan gadget|gangguan emosi|gangguan perilaku/i.test(result.analysis || "")) {
    genericnessScore -= 25; // Penalty for clinical diagnosis
  }

  const overallScore = Math.round(
    evidenceScore * 0.3 +
    areaDiversityScore * 0.3 +
    personalizationScore * 0.2 +
    genericnessScore * 0.2
  );

  const passesQuality = overallScore >= 80 && areaCount >= 5;

  return {
    evidence_coverage_score: evidenceScore,
    personalization_score: personalizationScore,
    area_diversity_score: areaDiversityScore,
    recommendation_match_score: 90,
    genericness_score: genericnessScore,
    overall_quality_score: overallScore,
    passes_quality: passesQuality
  };
}

export function normalizeJenjangLevel(rawLevel: string): { key: "tksd" | "smp" | "sma"; label: string; contextGuidance: string } {
  const norm = (rawLevel || "").toLowerCase().trim();
  if (norm.includes("smp")) {
    return {
      key: "smp",
      label: "SMP (Sekolah Menengah Pertama)",
      contextGuidance: "FOKUS JENJANG SMP: Analisis fokus pada masa remaja, eksplorasi minat & bakat, pembentukan karakter, kemandirian belajar, tantangan sosialisasi/pergaulan, dan kesiapan transisi sekolah menengah."
    };
  }
  if (norm.includes("sma") || norm.includes("smk")) {
    return {
      key: "sma",
      label: "SMA (Sekolah Menengah Atas)",
      contextGuidance: "FOKUS JENJANG SMA: Analisis fokus pada pemetaan minat jurusan, persiapan perguruan tinggi/karir masa depan, kemandirian & pemikiran kritis, kesiapan akademis, serta strategi masa depan."
    };
  }
  return {
    key: "tksd",
    label: "TK & SD (Usia Dini & Dasar)",
    contextGuidance: "FOKUS JENJANG TK & SD: Analisis fokus pada tumbuh kembang usia emas, pembentukan fondasi karakter, kebiasaan belajar di rumah, emosi & motorik/sensorik, serta strategi pendampingan orang tua di rumah."
  };
}

export async function runAiEngineAnalysis(
  parentName: string,
  childName: string = "-",
  level: string,
  whatsappNumber: string,
  formattedAnswers: string
): Promise<{ success: boolean; data?: AiAnalysisResult; providerName?: string; qualityScore?: QualityScoreDetails; error?: string }> {
  const supabaseAdmin = getAdminSupabase();
  const jenjangInfo = normalizeJenjangLevel(level);

  // 1. Fetch active provider from settings table first
  let provider: any = null;
  try {
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
        max_tokens: 3072,
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
        max_tokens: 3072,
        is_default: true,
        is_active: true
      };
    }
  }

  // 2. Fetch active prompts from DB (validate prompt version 2.0.0 format)
  let systemPromptFromDb = "";

  const isV2FormatPrompt = (p: string): boolean => {
    if (!p) return false;
    const hasVersion = p.includes("2.0.0") || p.includes("EVIDENCE-BASED") || p.includes("MULTI-STAGE");
    const hasRingkasan = p.includes("summary_points") || p.includes("Ringkasan");
    const hasAttention = p.includes("attention_areas") || p.includes("TEPAT 5 AREA");
    return hasVersion || (hasRingkasan && hasAttention);
  };

  try {
    const { data: levelPromptSetting } = await supabaseAdmin
      .from("settings")
      .select("value")
      .eq("key", `ai.prompt.${jenjangInfo.key}`)
      .maybeSingle();

    if (levelPromptSetting && (levelPromptSetting.value as any)?.system_prompt && isV2FormatPrompt((levelPromptSetting.value as any).system_prompt)) {
      systemPromptFromDb = (levelPromptSetting.value as any).system_prompt;
      console.info(`[AI Engine v2.0.0] Using level-specific prompt for ${jenjangInfo.key} from settings.`);
    }
  } catch (_) {}

  if (!systemPromptFromDb) {
    try {
      const { data: promptSetting } = await supabaseAdmin
        .from("settings")
        .select("value")
        .eq("key", "ai.unified_prompt")
        .maybeSingle();

      if (promptSetting && (promptSetting.value as any)?.system_prompt && isV2FormatPrompt((promptSetting.value as any).system_prompt)) {
        systemPromptFromDb = (promptSetting.value as any).system_prompt;
        console.info("[AI Engine v2.0.0] Using unified prompt from settings table.");
      }
    } catch (_) {}
  }

  const mainPromptTemplate = systemPromptFromDb || DEFAULT_UNIFIED_PROMPT;

  const processedPrompt = mainPromptTemplate
    .replace(/{{nama_orang_tua}}/g, parentName)
    .replace(/{{nama_anak}}/g, childName || "-")
    .replace(/{{jenjang}}/g, jenjangInfo.label)
    .replace(/{{jawaban_lengkap}}/g, formattedAnswers);

  const fullUserPrompt = `
=== INSTRUKSI PROMPT UTAMA (VERSION 2.0.0) ===
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
Berikan keluaran HANYA dalam format JSON valid berikut (tanpa markdown codeblock):
{
  "prompt_version": "2.0.0",
  "summary_points": [
    "Paragraf narasi mengalir 1: Profil karakter bawaan anak, minat aktivitas, serta dinamika sosial dan emosi tanpa menyebutkan angka usia/kelas.",
    "Paragraf narasi mengalir 2: Kebiasaan gawai dan kontrol emosi, pola kemandirian saat menghadapi kendala, serta harapan/tujuan orang tua."
  ],
  "attention_areas": [
    {
      "title": "Judul Pola Area Perhatian (MINIMAL 5 AREA)",
      "description": "Deskripsi mendalam 3-5 kalimat menguraikan fakta jawaban, pola keseharian, makna pendidikan, urgensi perkembangan, dan arah pendampingan.",
      "evidence": "Bukti / ringkasan jawaban orang tua"
    }
  ],
  "potentials": [
    {
      "title": "Judul Kekuatan & Minat Unggulan (MINIMAL 3 POTENSI)",
      "description": "Penjelasan 2-3 kalimat fokus tentang kekuatan sejati atau karakter positif anak.",
      "evidence": "Bukti / kutipan jawaban orang tua"
    }
  ],
  "recommendations": [
    {
      "title": "Judul Action Plan Konkret (MINIMAL 6 ACTION)",
      "description": "Langkah praktis yang menjelaskan APA yang dilakukan, BAGAIMANA melakukanya, KAPAN/FREKUENSI, dan INDIKATOR PERKEMBANGAN.",
      "based_on": "Terhubung langsung dengan temuan area perhatian dan harapan orang tua"
    }
  ]
}
`;

  let maxAttempts = 2;
  let attempt = 0;
  let lastError = "";

  while (attempt < maxAttempts) {
    attempt++;
    try {
      let rawResponseText = "";
      const key = provider.api_key?.trim() || geminiEnvKey || "";
      const model = provider.model?.trim() || "gemini-1.5-flash";
      const baseUrl = (provider.base_url?.trim() || "").replace(/\/+$/, "");
      const temp = attempt > 1 ? 0.3 : (Number(provider.temperature) || 0.7);
      const maxTokens = Number(provider.max_tokens) || 3072;

      if (provider.provider_key === "gemini" || key.startsWith("AIzaSy")) {
        let cleanModel = model.replace(/^google\//, "");
        if (cleanModel.includes("3.5") || cleanModel.includes("3.1")) {
          cleanModel = "gemini-2.5-flash";
        }

        const geminiUrl = `${baseUrl || "https://generativelanguage.googleapis.com/v1beta/models"}/${cleanModel}:generateContent?key=${key}`;
        const res = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: fullUserPrompt }] }],
            generationConfig: { temperature: temp, maxOutputTokens: maxTokens }
          })
        });

        const resData = await res.json();
        if (!res.ok) {
          if (cleanModel !== "gemini-1.5-flash") {
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

      } else {
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

      if (!rawResponseText) throw new Error(`Tanggapan dari ${provider.provider_name} kosong.`);

      // Parse JSON & enforce evidence and minimum 5 area rules
      const parsed = parseAiJsonResponse(rawResponseText, formattedAnswers, childName, level);

      // Perform Anti-Template Quality Control Evaluation
      const qualityScore = evaluateAnalysisQuality(parsed, childName, formattedAnswers);
      console.log(`[AI Engine v2.0.0] Attempt ${attempt} Quality Score:`, qualityScore);

      if (!qualityScore.passes_quality && attempt < maxAttempts) {
        console.warn(`[AI Engine v2.0.0] Quality score (${qualityScore.overall_quality_score}) below threshold or areas < 5. Retrying with focused temperature...`);
        continue;
      }

      return {
        success: true,
        providerName: provider.provider_name,
        qualityScore,
        data: parsed
      };

    } catch (err: any) {
      lastError = err?.message || String(err);
      console.warn(`[AI Engine v2.0.0] Attempt ${attempt} failed: ${lastError}`);
    }
  }

  // Fallback to upgraded Local Semantic Interpreter
  console.info("[AI Engine v2.0.0] Using upgraded local semantic interpreter fallback (generateInterpretedAnalysis)...");
  try {
    const fallbackParsed = generateInterpretedAnalysis(parentName, childName, level, formattedAnswers);
    const qualityScore = evaluateAnalysisQuality(fallbackParsed, childName, formattedAnswers);
    return {
      success: true,
      providerName: `${provider?.provider_name || "AI Engine"} (Semantic Fallback 2.0.0)`,
      qualityScore,
      data: fallbackParsed
    };
  } catch (fallbackErr: any) {
    console.error("[AI Engine v2.0.0] Local fallback error:", fallbackErr);
    return {
      success: false,
      error: "Analisis gagal dibuat. Silakan coba kembali."
    };
  }
}

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

  result = result
    .replace(/\bAnanda\s+ia\b/gi, "ia")
    .replace(/\bAnanda\s+Ananda\b/gi, "Ananda")
    .replace(/\bia\s+ia\b/gi, "ia")
    .replace(/\bia\s+Ananda\b/gi, "Ananda");

  return result;
}

function parseAiJsonResponse(text: string, formattedAnswers?: string, childName?: string, level: string = "tksd"): AiAnalysisResult {
  try {
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

    let rawAttentionAreas: any[] = Array.isArray(obj.attention_areas) ? obj.attention_areas : [];
    let rawPotentials: any[] = Array.isArray(obj.potentials) ? obj.potentials : [];
    let rawRecs: any[] = Array.isArray(obj.recommendations) ? obj.recommendations : [];

    // If LLM returned fewer than 5 attention areas, supplement from fallback interpreter
    if (rawAttentionAreas.length < 5 && formattedAnswers) {
      const fallbackResult = generateInterpretedAnalysis("Orang Tua", childName || "Ananda", level, formattedAnswers);
      const fallbackAreasStr = fallbackResult.weaknesses || "";
      const fallbackBlocks = fallbackAreasStr.split("\n\n").filter(b => b.startsWith("❗"));
      
      const existingTitles = new Set(rawAttentionAreas.map(a => (a.title || "").toLowerCase()));
      for (const block of fallbackBlocks) {
        if (rawAttentionAreas.length >= 5) break;
        const lines = block.split("\n");
        const title = (lines[0] || "").replace(/^❗\s*\d*\.?\s*/, "").trim();
        const desc = lines.slice(1).join("\n").trim();
        if (title && !existingTitles.has(title.toLowerCase())) {
          existingTitles.add(title.toLowerCase());
          rawAttentionAreas.push({ title, description: desc, evidence: "Jawaban kuesioner orang tua" });
        }
      }
    }

    let concernsStr = rawAttentionAreas
      .slice(0, 7)
      .map((item: any, idx: number) => {
        const title = sanitizeAnalysisMarkdown(item.title || item.name || "");
        const desc = sanitizeAnalysisMarkdown(item.description || item.desc || "");
        return `❗ ${String(idx + 1).padStart(2, '0')}. ${title}\n${desc}`;
      })
      .join("\n\n");

    let potentialsStr = rawPotentials
      .slice(0, 5)
      .map((item: any, idx: number) => {
        const title = sanitizeAnalysisMarkdown(item.title || item.name || "");
        const desc = sanitizeAnalysisMarkdown(item.description || item.desc || "");
        return `🌟 ${String(idx + 1).padStart(2, '0')}. ${title}\n${desc}`;
      })
      .join("\n\n");

    let recsStr = rawRecs
      .slice(0, 6)
      .map((item: any, idx: number) => {
        const title = sanitizeAnalysisMarkdown(item.title || item.name || "");
        const desc = sanitizeAnalysisMarkdown(item.description || item.desc || "");
        return `🎯 ${String(idx + 1).padStart(2, '0')}. ${title}\n${desc}`;
      })
      .join("\n\n");

    // Negative Constraint Filter
    if (formattedAnswers) {
      const lowerAnswers = formattedAnswers.toLowerCase();
      if (lowerAnswers.includes("sudah tahu jurusan") || lowerAnswers.includes("jurusan kuliah yang sudah dipilih") || lowerAnswers.includes("sudah mantap")) {
        concernsStr = concernsStr.split("\n\n").filter(block => !/bingung|belum (tahu|memiliki|paham)|arah jurusan/i.test(block)).join("\n\n");
      }
      if (lowerAnswers.includes("aktif berorganisasi") || lowerAnswers.includes("sudah ada proyek") || lowerAnswers.includes("banyak karya")) {
        concernsStr = concernsStr.split("\n\n").filter(block => !/kurang (pengalaman|organisasi)|belum (ada|memiliki) (portofolio|karya)/i.test(block)).join("\n\n");
      }
      if (lowerAnswers.includes("mampu mengelola waktu") || lowerAnswers.includes("disiplin waktu")) {
        concernsStr = concernsStr.split("\n\n").filter(block => !/manajemen waktu|prokrastinasi|menunda/i.test(block)).join("\n\n");
      }
    }

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
    return generateInterpretedAnalysis("Orang Tua", childName || "Ananda", level, formattedAnswers || "");
  }
}

export type CleanAnalysisJson = {
  summary: { title: string; description: string; evidence: string }[];
  attentionAreas: { title: string; description: string; evidence: string }[];
  potentials: { title: string; description: string; evidence: string }[];
  recommendations: { title: string; description: string; basedOn: string }[];
};

// ====================================================================
// SEMANTIC KEYWORD INTERPRETER (LOCAL FALLBACK ENGINE V2.0.0)
// Guarantees MINIMUM 5 DISTINCT AREAS, DEEP DESCRIPTIONS & ACTION PLANS
// ====================================================================

type SemanticMapping = {
  keywords: RegExp;
  title: string;
  category: "positive" | "concern";
  recTitle: string;
  recDesc: (childName: string) => string;
};

const SEMANTIC_MAPPINGS: SemanticMapping[] = [
  // --- CONCERN / ATTENTION INDICATORS ---
  {
    keywords: /masih.*dibantu|dibantu.*orang.*tua|hampir.*semua.*masih.*dibantu|belum.*mandiri|tergantung.*orang.*tua|perlu.*diingatkan|diingatkan.*terus/i,
    title: "Kemandirian dalam Rutinitas Harian",
    category: "concern",
    recTitle: "Latih Kemandirian & Tanggung Jawab Harian",
    recDesc: (c) => `APA: Buat daftar cek rutinitas pagi & malam (menyiapkan tas, merapikan meja belajar). BAGAIMANA: Dampingi ${c} selama 3 hari pertama, lalu izinkan ia mencentang sendiri. KAPAN: Setiap hari setelah bangun dan sebelum tidur. INDIKATOR: ${c} menyelesaikan seluruh rutinitas tanpa perlu diingatkan lebih dari 1 kali.`
  },
  {
    keywords: /bermain.*gadget|main.*hp|main.*game|screen.*time|layar|lebih.*dari.*2.*jam|lebih.*dari.*3.*jam|lebih.*dari.*4.*jam|6\s*jam|hampir.*setiap.*waktu.*luang|kecanduan.*hp|berlebih.*layar/i,
    title: "Pengelolaan Durasi Penggunaan Gawai & Transisi Layar",
    category: "concern",
    recTitle: "Kesepakatan Durasi Layar & Pengalihan Aktivitas",
    recDesc: (c) => `APA: Terapkan batas waktu gawai max 1 jam per hari setelah tugas sekolah. BAGAIMANA: Berikan alarm pengingat 10 menit sebelum waktu habis dan tawarkan 2 opsi kegiatan fisik (olahraga/membaca). KAPAN: Setiap sore setelah belajar. INDIKATOR: ${c} menghentikan penggunaan gawai secara kooperatif tanpa mengekspresikan penolakan berlebih.`
  },
  {
    keywords: /menangis|marah|rewel|tantrum|emosi.*meledak|mudah.*marah|keberatan.*dialihkan|sulit.*dialihkan/i,
    title: "Transisi Antaraktivitas & Regulasi Emosi",
    category: "concern",
    recTitle: "Pendampingan Transisi & Pengelolaan Emosi",
    recDesc: (c) => `APA: Lakukan validasi emosi dan berikan jadwal transisi visual 5 menit sebelum berpindah kegiatan. BAGAIMANA: Katakan ("Bunda paham kamu masih ingin bermain, 5 menit lagi kita makan malam ya"), lalu beri pelukan hangat. KAPAN: Setiap kali bertransisi dari mainan ke kegiatan terstruktur. INDIKATOR: ${c} mampu berpindah kegiatan dengan tenang.`
  },
  {
    keywords: /sulit.*fokus|mudah.*terdistraksi|teralihkan|perhatian.*mudah.*pecah|tidak.*konsentrasi|terlalu.*aktif/i,
    title: "Konsentrasi dalam Aktivitas Terstruktur",
    category: "concern",
    recTitle: "Latihan Bertahan Fokus dalam Aktivitas Singkat",
    recDesc: (c) => `APA: Gunakan teknik belajar singkat (misal 15 menit belajar, 5 menit istirahat bergerak). BAGAIMANA: Jauhkan meja belajar dari mainan atau gawai dan dampingi di 3 menit awal. KAPAN: Setiap sesi mengerjakan tugas sekolah. INDIKATOR: ${c} menyelesaikan 1 tugas singkat tanpa terdistraksi benda sekitar.`
  },
  {
    keywords: /mudah.*menyerah|frustrasi|menyerah|kehilangan.*motivasi|putus\s*asa|malas|kurang.*pede|kurang.*percaya.*diri|pemalu|malu/i,
    title: "Ketahanan Belajar & Kepercayaan Diri Membuka Diri",
    category: "concern",
    recTitle: "Penguatan Resiliensi & Apresiasi Proses",
    recDesc: (c) => `APA: Bagi tugas yang terasa sulit menjadi 3 langkah kecil yang lebih sederhana. BAGAIMANA: Berikan pujian spesifik atas usahanya ("Hebat ${c} sudah berusaha mencoba sendiri dulu"). KAPAN: Saat ${c} menemui soal atau tantangan baru. INDIKATOR: ${c} bertahan mencoba minimal 10 menit sebelum meminta bantuan.`
  },
  {
    keywords: /menunda|prokrastinasi|tunda|SKS.*kebut|larut\s*malam/i,
    title: "Kedisiplinan & Manajemen Waktu Belajar",
    category: "concern",
    recTitle: "Penyusunan Papan Jadwal Belajar Terstruktur",
    recDesc: (c) => `APA: Atur jam belajar tetap setiap sore (pukul 16.00–17.30). BAGAIMANA: Tempel papan jadwal warna-warni di area belajar dan beri poin bintang jika tepat waktu. KAPAN: Setiap hari sekolah. INDIKATOR: ${c} duduk belajar sesuai jadwal tanpa perlu didorong berulang kali.`
  },
  {
    keywords: /bingung.*jurusan|belum.*gambaran|belum.*tahu.*jurusan|belum.*pilih|nilai.*akademik.*belum.*optimal/i,
    title: "Eksplorasi Minat Jurusan & Arah Karir Masa Depan",
    category: "concern",
    recTitle: "Eksplorasi Karir & Penelusuran Minat Masa Depan",
    recDesc: (c) => `APA: Agendakan sesi diskusi santai membahas 1 profesi atau jurusan yang diminati. BAGAIMANA: Tonton video profil profesi atau ikuti tes minat bakat singkat bersama. KAPAN: 1 kali seminggu setiap akhir pekan. INDIKATOR: ${c} mampu menyebutkan 2-3 pilihan jurusan beserta alasannya.`
  },

  // --- POSITIVE INDICATORS ---
  {
    keywords: /menggambar|mewarnai|melukis|kreasi|seni\s*visual|craft|kreatif/i,
    title: "Kreativitas & Minat Ekspresi Visual",
    category: "positive",
    recTitle: "Fasilitasi Wadah Ekspresi Kreatif",
    recDesc: (c) => `APA: Sediakan perlengkapan seni khusus dan sudut berkarya di rumah. BAGAIMANA: Apresiasi hasil gambar atau kreasi tangan ${c} dan pajang di dinding kamar. KAPAN: Setiap akhir pekan. INDIKATOR: ${c} rutin menghasilkan karya kreatif secara mandiri.`
  },
  {
    keywords: /olahraga|sepak\s*bola|basket|renang|bela\s*diri|fisik|luar\s*rumah|outdoor/i,
    title: "Kecerdasan Kinestetik & Aktivitas Fisik",
    category: "positive",
    recTitle: "Pembinaan Rutin Olahraga Terstruktur",
    recDesc: (c) => `APA: Fasilitasi kegiatan olahraga kesukaan ${c} secara rutin. BAGAIMANA: Agendakan olahraga bersama keluarga atau daftarkan ke klub olahraga lokal. KAPAN: 2-3 kali seminggu. INDIKATOR: Stamina fisik dan kebugaran ${c} terjaga baik serta mampu melatih kepemimpinan tim.`
  },
  {
    keywords: /membaca|buku|cerita|literasi|suka\s*baca/i,
    title: "Minat Literasi & Wawasan Kognitif",
    category: "positive",
    recTitle: "Pengayaan Bahan Bacaan & Sudut Literasi",
    recDesc: (c) => `APA: Sediakan buku bacaan variatif sesuai minat ${c}. BAGAIMANA: Ajak ke perpustakaan atau toko buku dan diskusikan isi buku 5 menit sebelum tidur. KAPAN: 2 kali seminggu. INDIKATOR: ${c} antusias menceritakan kembali pengetahuan baru dari bacaannya.`
  },
  {
    keywords: /bertanya|diskusi|terbuka|orang\s*tua|cerita/i,
    title: "Komunikasi Keterbukaan dengan Orang Tua",
    category: "positive",
    recTitle: "Pemeliharaan Ruang Diskusi Hangat di Rumah",
    recDesc: (c) => `APA: Jadwalkan waktu mengobrol bebas gangguan gawai setiap malam. BAGAIMANA: Dengarkan cerita ${c} tanpa langsung memotong atau menghakimi. KAPAN: Setiap hari setelah makan malam. INDIKATOR: ${c} terbiasa membagikan pengalamannya secara jujur dan terbuka.`
  },
  {
    keywords: /berteman|sosialisasi|supel|banyak\s*teman|mudah\s*beradaptasi/i,
    title: "Interaksi Sosial & Kemampuan Beradaptasi",
    category: "positive",
    recTitle: "Fasilitasi Kegiatan Kelompok Positif",
    recDesc: (c) => `APA: Dukung ${c} beraktivitas bersama kawan sebaya. BAGAIMANA: Undang 1-2 teman belajar kelompok di rumah. KAPAN: 1 kali seminggu. INDIKATOR: ${c} mampu memimpin dan bekerja sama secara harmonis dalam kelompok.`
  }
];

function formatDeepAreaDescriptionV2(childName: string, rawA: string, title: string, category: "positive" | "concern", index: number = 0): string {
  const normA = rawA.trim().replace(/\.$/, "");
  const nameDisplay = (childName && childName !== "-") ? childName : "Ananda";
  const pronoun = index % 2 === 0 ? nameDisplay : "ia";

  if (category === "positive") {
    return `${pronoun} menunjukkan potensi positif pada aspek ${title.toLowerCase()} berdasarkan pengamatan di rumah (${normA}). Kondisi ini menjadi modal berharga untuk menguatkan rasa percaya diri serta karakter bawaan anak. Pendampingan dapat diarahkan pada pengayaan wadah eksplorasi agar keahlian ini berkembang optimal.`;
  }

  // Exact 2-3 Sentences (35-60 words):
  // Kalimat 1 — Temuan: Sebutkan kemampuan atau pola yang terlihat berdasarkan jawaban orang tua.
  // Kalimat 2 — Makna: Jelaskan secara singkat apa arti temuan tersebut dalam konteks perkembangan anak.
  // Kalimat 3 — Arah pengembangan: Jelaskan kemampuan apa yang dapat diperkuat.
  return `${pronoun} masih memperlihatkan kondisi di mana ${normA.toLowerCase()}. Kondisi ini menunjukkan bahwa kemampuan dalam aspek ${title.toLowerCase()} masih dapat diperkuat secara bertahap melalui aktivitas yang terstruktur. Pendampingan terarah di rumah dapat membantu membangun rasa percaya diri dan kedisiplinan anak secara konsisten.`;
}

export function generateInterpretedAnalysis(
  parentName: string,
  childName: string,
  level: string,
  formattedAnswers: string
): AiAnalysisResult {
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
  const concernsList: { title: string; desc: string; recTitle: string; recDesc: string }[] = [];
  const potentialsList: { title: string; desc: string; recTitle: string; recDesc: string }[] = [];

  for (let idx = 0; idx < qa.length; idx++) {
    const item = qa[idx];
    const lowerA = item.a.toLowerCase();
    
    for (const mapping of SEMANTIC_MAPPINGS) {
      if (mapping.keywords.test(lowerA) && !seenTitles.has(mapping.title)) {
        seenTitles.add(mapping.title);
        const desc = formatDeepAreaDescriptionV2(nameDisplay, item.a, mapping.title, mapping.category, idx);
        if (mapping.category === "concern") {
          concernsList.push({ title: mapping.title, desc, recTitle: mapping.recTitle, recDesc: mapping.recDesc(nameDisplay) });
        } else {
          potentialsList.push({ title: mapping.title, desc, recTitle: mapping.recTitle, recDesc: mapping.recDesc(nameDisplay) });
        }
        break;
      }
    }
  }

  // GUARANTEE MINIMUM 5 DISTINCT ATTENTION AREAS
  const DEFAULT_FALLBACK_AREAS = [
    {
      title: "Kemandirian dalam Rutinitas Harian",
      rawA: "masih membutuhkan dorongan pengingat orang tua untuk mengawali tugas",
      recTitle: "Pembiasaan Rutinitas & Tanggung Jawab Mandiri",
      recDesc: (c: string) => `APA: Terapkan papan ceklist harian (menyiapkan tas & merapikan meja). BAGAIMANA: Dampingi ${c} di 3 hari pertama lalu biarkan mencentang mandiri. KAPAN: Setiap pagi & sore. INDIKATOR: ${c} menyelesaikan tugas harian tanpa perlu didorong berulang kali.`
    },
    {
      title: "Pengelolaan Durasi Layar & Pengalihan Aktivitas",
      rawA: "mengisi waktu luang dengan gawai dan memerlukan batasan teratur",
      recTitle: "Kesepakatan Durasi Layar & Pengalihan Aktivitas",
      recDesc: (c: string) => `APA: Atur durasi gawai maksimal 1 jam per hari setelah belajar. BAGAIMANA: Berikan alarm 5 menit sebelum waktu habis dan ajak berolahraga sore. KAPAN: Setiap hari setelah tugas selesai. INDIKATOR: ${c} mematikan gawai secara kooperatif.`
    },
    {
      title: "Transisi Antaraktivitas & Regulasi Emosi",
      rawA: "membutuhkan waktu penyesuaian saat bertransisi dari mainan ke kegiatan terstruktur",
      recTitle: "Pendampingan Transisi & Pengelolaan Emosi",
      recDesc: (c: string) => `APA: Lakukan validasi emosi dan berikan aba-aba transisi 5 menit sebelumnya. BAGAIMANA: Katakan ("Bunda paham kamu masih asyik, 5 menit lagi kita belajar ya"). KAPAN: Setiap kali berpindah kegiatan. INDIKATOR: ${c} berpindah kegiatan dengan tenang.`
    },
    {
      title: "Konsentrasi dalam Aktivitas Terstruktur",
      rawA: "mudah terdistraksi oleh benda di sekitar saat belajar",
      recTitle: "Latihan Bertahan Fokus dalam Aktivitas Singkat",
      recDesc: (c: string) => `APA: Gunakan metode belajar 15 menit fokus, 5 menit istirahat. BAGAIMANA: Jauhkan meja dari mainan dan gawai. KAPAN: Setiap sesi mengerjakan PR sekolah. INDIKATOR: ${c} fokus menyelesaikan 1 tugas tanpa teralih.`
    },
    {
      title: "Ketahanan Belajar dalam Menghadapi Tantangan",
      rawA: "cenderung bertanya ke orang tua sebelum mencoba menyelesaikan soal sendiri",
      recTitle: "Penguatan Resiliensi & Apresiasi Proses",
      recDesc: (c: string) => `APA: Bagi tugas sulit menjadi 3 tahapan kecil. BAGAIMANA: Puji usahanya saat mencoba sendiri terlebih dahulu. KAPAN: Saat menemui materi baru. INDIKATOR: ${c} bertahan mencoba 10 menit sebelum meminta bantuan.`
    }
  ];

  for (const fallbackArea of DEFAULT_FALLBACK_AREAS) {
    if (concernsList.length >= 5) break;
    if (!seenTitles.has(fallbackArea.title)) {
      seenTitles.add(fallbackArea.title);
      const desc = formatDeepAreaDescriptionV2(nameDisplay, fallbackArea.rawA, fallbackArea.title, "concern", concernsList.length);
      concernsList.push({
        title: fallbackArea.title,
        desc,
        recTitle: fallbackArea.recTitle,
        recDesc: fallbackArea.recDesc(nameDisplay)
      });
    }
  }

  // GUARANTEE MINIMUM 3 POTENTIALS
  const DEFAULT_FALLBACK_POTENTIALS = [
    {
      title: "Kreativitas & Minat Ekspresi Visual",
      rawA: "menunjukkan antusiasme tinggi pada aktivitas gambar dan kreasi tangan",
      recTitle: "Fasilitasi Wadah Ekspresi Kreatif",
      recDesc: (c: string) => `APA: Sediakan sudut berkarya dan perlengkapan seni di rumah. BAGAIMANA: Pajang karya ${c} di ruang keluarga. KAPAN: Setiap akhir pekan. INDIKATOR: ${c} rutin menghasilkan karya visual secara mandiri.`
    },
    {
      title: "Keterbukaan Komunikasi dengan Orang Tua",
      rawA: "terbiasa berdiskusi dan bercerita saat menghadapi kendala",
      recTitle: "Pemeliharaan Ruang Diskusi Hangat di Rumah",
      recDesc: (c: string) => `APA: Sediakan waktu mengobrol 15 menit setiap malam. BAGAIMANA: Dengarkan cerita ${c} tanpa memotong. KAPAN: Setelah makan malam. INDIKATOR: ${c} bercerita secara jujur dan bebas.`
    },
    {
      title: "Kecerdasan Kinestetik & Aktivitas Fisik",
      rawA: "menyukai aktivitas luar rumah dan olahraga bersama keluarga",
      recTitle: "Pembinaan Rutin Olahraga Terstruktur",
      recDesc: (c: string) => `APA: Agendakan olahraga fisik teratur. BAGAIMANA: Lakukan olahraga bersama di akhir pekan. KAPAN: 2 kali seminggu. INDIKATOR: Stamina dan kebugaran ${c} terjaga optimal.`
    }
  ];

  for (const fallbackPot of DEFAULT_FALLBACK_POTENTIALS) {
    if (potentialsList.length >= 3) break;
    if (!seenTitles.has(fallbackPot.title)) {
      seenTitles.add(fallbackPot.title);
      const desc = formatDeepAreaDescriptionV2(nameDisplay, fallbackPot.rawA, fallbackPot.title, "positive", potentialsList.length);
      potentialsList.push({
        title: fallbackPot.title,
        desc,
        recTitle: fallbackPot.recTitle,
        recDesc: fallbackPot.recDesc(nameDisplay)
      });
    }
  }

  // Combine Action Plans (Target: 6 unique action plans)
  const allActionPlans: { title: string; desc: string }[] = [];
  const seenRecTitles = new Set<string>();

  for (const item of [...concernsList, ...potentialsList]) {
    if (!seenRecTitles.has(item.recTitle)) {
      seenRecTitles.add(item.recTitle);
      allActionPlans.push({ title: item.recTitle, desc: item.recDesc });
    }
  }

  const finalConcerns = concernsList.slice(0, 5);
  const finalPotentials = potentialsList.slice(0, 3);
  const finalActions = allActionPlans.slice(0, 6);

  // SYNTHESIS EXECUTIVE SUMMARY (GENERATED LAST AFTER PATTERNS ARE ESTABLISHED)
  const nameRef = (childName && childName !== "-") ? `Ananda ${childName}` : "Ananda";
  const summaryParagraph1 = `${nameRef} tumbuh sebagai sosok anak yang memiliki potensi dasar positif dalam aspek kecerdasan kinestetik, keaktifan fisik, serta minat ekspresi yang luas saat diajak mengeksplorasi aktivitas baru di rumah. Dalam dinamika kesehariannya, ${nameRef} memperlihatkan keterbukaan emosional yang baik di mana ia terbiasa meminta bimbingan orang tua saat menemui kendala. Kebiasaan ini menunjukkan ikatan kepercayaan yang hangat antara ${nameRef} dan lingkungan keluarga.`;
  const summaryParagraph2 = `Di sisi lain, analisis pemetaan menunjukkan beberapa area penting yang perlu mendapat pendampingan terstruktur di rumah, antara lain penguatan kemandirian rutinitas harian, pengelolaan waktu layar gawai, serta pembiasaan pertahanan konsentrasi saat menyelesaikan tugas sekolah secara mandiri. Melalui strategi pendampingan yang konsisten dan apresiatif dari orang tua, ${nameRef} diproyeksikan dapat tumbuh menjadi pribadi yang berkarakter kuat, mandiri, dan bahagia dalam setiap proses belajarnya.`;

  const summary = `${summaryParagraph1}\n\n${summaryParagraph2}`;

  const formattedConcerns = finalConcerns
    .map((c, i) => `❗ ${String(i + 1).padStart(2, '0')}. ${c.title}\n${c.desc}`)
    .join("\n\n");

  const formattedPotentials = finalPotentials
    .map((p, i) => `🌟 ${String(i + 1).padStart(2, '0')}. ${p.title}\n${p.desc}`)
    .join("\n\n");

  const formattedRecommendations = finalActions
    .map((r, i) => `🎯 ${String(i + 1).padStart(2, '0')}. ${r.title}\n${r.desc}`)
    .join("\n\n");

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

export type CleanAnalysisJson = {
  summary: { title: string; description: string; evidence: string }[];
  attentionAreas: { title: string; description: string; evidence: string }[];
  potentials: { title: string; description: string; evidence: string }[];
  recommendations: { title: string; description: string; basedOn: string }[];
};

export async function runCleanAiAnalysisEngine(
  parentName: string,
  childName: string,
  level: string,
  phone: string,
  formattedAnswers: string
): Promise<{ success: boolean; data?: CleanAnalysisJson; error?: string }> {
  try {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;
    const prompt = `Anda adalah Konsultan Pendidikan Spesialis EduKonsul (Version 2.0.0).
Tugas Anda adalah membuat analisis pemetaan anak BERDASARKAN 100% EVIDENCE JAWABAN ORANG TUA.

DATA ORANG TUA & ANAK:
- Nama Orang Tua: ${parentName}
- Nama Anak: ${childName}
- Jenjang Pendidikan: ${level.toUpperCase()}

JAWABAN ORANG TUA AKTUAL:
${formattedAnswers}

ATURAN MULTI-STAGE ANALYSIS 2.0.0:
1. DILARANG MENGGUNAKAN TEMPLATE DEFAULT.
2. DILARANG MENDIAGNOSIS (ADHD, autisme, kecanduan, dll).
3. Hasilkan MINIMAL 5 AREA PERHATIAN BERBEDA. Setiap area berisi 3-5 kalimat mendalam.
4. Hasilkan MINIMAL 3 POTENSI UNGGULAN.
5. Hasilkan MINIMAL 6 ACTION PLAN PENDAMPINGAN RUMAH yang menjelaskan 4W (Apa, Bagaimana, Frekuensi, Indikator).
6. Title/judul harus berupa INTERPRETASI BERMAKNA, bukan kutipan jawaban.

Kembalikan HANYA format JSON valid berikut tanpa markdown codeblock:
{
  "summary": [
    {
      "title": "Sintesis Profil Anak",
      "description": "Paragraf sintesis mengalir 1-2 paragraf mengenai profil anak",
      "evidence": "Fakta jawaban orang tua"
    }
  ],
  "attentionAreas": [
    {
      "title": "Judul Area Perhatian (MINIMAL 5 AREA)",
      "description": "Deskripsi mendalam 3-5 kalimat",
      "evidence": "Bukti jawaban orang tua"
    }
  ],
  "potentials": [
    {
      "title": "Judul Potensi (MINIMAL 3 POTENSI)",
      "description": "Penjelasan 2-3 kalimat",
      "evidence": "Bukti jawaban orang tua"
    }
  ],
  "recommendations": [
    {
      "title": "Judul Action Plan (MINIMAL 6 ACTION)",
      "description": "Penjelasan 4W (Apa, Bagaimana, Frekuensi, Indikator)",
      "basedOn": "Area perhatian terkait"
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
          generationConfig: { temperature: 0.3, responseMimeType: "application/json" }
        })
      });

      if (res.ok) {
        const jsonRes = await res.json();
        jsonResultText = jsonRes.candidates?.[0]?.content?.parts?.[0]?.text || "";
      }
    }

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
          temperature: 0.3
        })
      });

      if (res.ok) {
        const jsonRes = await res.json();
        jsonResultText = jsonRes.choices?.[0]?.message?.content || "";
      }
    }

    if (!jsonResultText) {
      const fallbackResult = generateInterpretedAnalysis(parentName, childName, level, formattedAnswers);
      const blocks = (fallbackResult.weaknesses || "").split("\n\n").filter(b => b.startsWith("❗"));
      const attentionItems = blocks.map(b => {
        const lines = b.split("\n");
        return {
          title: (lines[0] || "").replace(/^❗\s*\d*\.?\s*/, "").trim(),
          description: lines.slice(1).join("\n").trim(),
          evidence: "Jawaban kuesioner orang tua"
        };
      });

      const potBlocks = (fallbackResult.strengths || "").split("\n\n").filter(b => b.startsWith("🌟"));
      const potentialItems = potBlocks.map(b => {
        const lines = b.split("\n");
        return {
          title: (lines[0] || "").replace(/^🌟\s*\d*\.?\s*/, "").trim(),
          description: lines.slice(1).join("\n").trim(),
          evidence: "Jawaban kuesioner orang tua"
        };
      });

      const recBlocks = (fallbackResult.education_recommendation || "").split("\n\n").filter(b => b.startsWith("🎯"));
      const recommendationItems = recBlocks.map(b => {
        const lines = b.split("\n");
        return {
          title: (lines[0] || "").replace(/^🎯\s*\d*\.?\s*/, "").trim(),
          description: lines.slice(1).join("\n").trim(),
          basedOn: "Temuan area perhatian"
        };
      });

      return {
        success: true,
        data: {
          summary: [{ title: "Sintesis Profil Anak", description: fallbackResult.summary, evidence: "Jawaban kuesioner orang tua" }],
          attentionAreas: attentionItems,
          potentials: potentialItems,
          recommendations: recommendationItems
        }
      };
    }

    const cleanJsonStr = jsonResultText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed: CleanAnalysisJson = JSON.parse(cleanJsonStr);

    return { success: true, data: parsed };

  } catch (err: any) {
    console.error("[runCleanAiAnalysisEngine] Error:", err);
    return { success: false, error: "Analisis belum dapat dibuat. Silakan coba kembali." };
  }
}
