-- =========================================================================
-- FULL SCHEMA MIGRATION & SEED FOR KONSULTAN PENDIDIKAN AL-KARIM (NEW DB)
-- Cara Pakai: Copy seluruh teks ini dan Paste ke SQL Editor di Supabase Baru, lalu Klik RUN.
-- =========================================================================

-- 1. Create Custom Types / Enums
DO $$ BEGIN
    CREATE TYPE public.education_level AS ENUM ('tksd', 'smp', 'sma');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.question_type AS ENUM ('text', 'textarea', 'single_choice', 'multi_choice');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.app_role AS ENUM ('admin', 'user');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Create Tables
CREATE TABLE IF NOT EXISTS public.questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    level public.education_level NOT NULL,
    question_text TEXT NOT NULL,
    question_type public.question_type NOT NULL DEFAULT 'single_choice',
    order_index INT NOT NULL DEFAULT 1,
    is_required BOOLEAN NOT NULL DEFAULT true,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.question_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
    option_text TEXT NOT NULL,
    order_index INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.consultations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_name TEXT NOT NULL,
    whatsapp_number TEXT NOT NULL,
    child_name TEXT,
    level public.education_level NOT NULL,
    status TEXT NOT NULL DEFAULT 'Menunggu Analisis',
    ai_result TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.consultation_answers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    consultation_id UUID NOT NULL REFERENCES public.consultations(id) ON DELETE CASCADE,
    question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
    answer_text TEXT,
    selected_option_ids UUID[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.consultation_analysis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    consultation_id UUID UNIQUE NOT NULL REFERENCES public.consultations(id) ON DELETE CASCADE,
    summary TEXT,
    strengths TEXT,
    weaknesses TEXT,
    potential TEXT,
    risk TEXT,
    education_recommendation TEXT,
    analysis TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    is_public BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.user_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    role public.app_role NOT NULL DEFAULT 'user',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Enable RLS and Grant Permissions
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consultations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consultation_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consultation_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Allow Public SELECT for Questions, Options, and Settings
DROP POLICY IF EXISTS "Public can read questions" ON public.questions;
CREATE POLICY "Public can read questions" ON public.questions FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public can read options" ON public.question_options;
CREATE POLICY "Public can read options" ON public.question_options FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public can read settings" ON public.settings;
CREATE POLICY "Public can read settings" ON public.settings FOR SELECT USING (true);

-- Allow Public INSERT for Consultations and Answers (Forms Submission)
DROP POLICY IF EXISTS "Public can insert consultations" ON public.consultations;
CREATE POLICY "Public can insert consultations" ON public.consultations FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Public can insert answers" ON public.consultation_answers;
CREATE POLICY "Public can insert answers" ON public.consultation_answers FOR INSERT WITH CHECK (true);

-- Allow Service Role and Admin Full Access
DROP POLICY IF EXISTS "Allow All for Service Role on consultations" ON public.consultations;
CREATE POLICY "Allow All for Service Role on consultations" ON public.consultations USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow All for Service Role on answers" ON public.consultation_answers;
CREATE POLICY "Allow All for Service Role on answers" ON public.consultation_answers USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow All for Service Role on analysis" ON public.consultation_analysis;
CREATE POLICY "Allow All for Service Role on analysis" ON public.consultation_analysis USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow All for Service Role on settings" ON public.settings;
CREATE POLICY "Allow All for Service Role on settings" ON public.settings USING (true) WITH CHECK (true);

-- Grant privileges to anon and authenticated roles
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT INSERT ON public.consultations, public.consultation_answers TO anon, authenticated;

-- 4. Initial Default Settings
INSERT INTO public.settings (key, value, is_public) VALUES 
('ai_config', '{"model": "gemini-1.5-flash", "temperature": 0.7, "system_prompt": "Anda adalah Konsultan Pendidikan Ahli Al-Karim."}', true),
('site_config', '{"siteName": "Sekolah Alam Al-Karim", "footerWa": "6281234567890"}', true)
ON CONFLICT (key) DO NOTHING;

-- Complete!
