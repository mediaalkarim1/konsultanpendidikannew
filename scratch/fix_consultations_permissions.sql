-- =========================================================================
-- FIX PERMISSIONS & RLS FOR KONSULTAN PENDIDIKAN TABLES
-- Copy dan Paste perintah ini ke Supabase Dashboard -> SQL Editor -> Run
-- =========================================================================

-- 1. Grant Schema Usage
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- 2. Grant Table Permissions for Consultations & Answers
GRANT ALL ON public.consultations TO anon, authenticated, service_role;
GRANT ALL ON public.consultation_answers TO anon, authenticated, service_role;
GRANT ALL ON public.consultation_analysis TO anon, authenticated, service_role;
GRANT ALL ON public.questions TO anon, authenticated, service_role;
GRANT ALL ON public.question_options TO anon, authenticated, service_role;
GRANT ALL ON public.settings TO anon, authenticated, service_role;

-- 3. Ensure Row Level Security (RLS) Policies Allow Insert & Select
ALTER TABLE public.consultations DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.consultation_answers DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.consultation_analysis DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_options DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings DISABLE ROW LEVEL SECURITY;

-- Finish!
