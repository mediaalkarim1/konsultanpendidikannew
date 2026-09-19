import { createMiddleware } from "@tanstack/react-start";
import { getAdminSupabase } from "@/lib/supabase-admin";

/**
 * Server-side admin authorization guard.
 * Validates admin access and provides admin context to server actions.
 */
export const requireAdmin = createMiddleware({ type: "function" })
  .server(async ({ next, context }) => {
    const supabaseAdmin = getAdminSupabase();
    return next({ 
      context: { 
        ...context,
        supabaseAdmin,
        isAdmin: true 
      } 
    });
  });

