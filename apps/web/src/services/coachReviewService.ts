import { supabase } from '@/lib/supabase';

export const coachReviewService = {
  async getPendingQueue() {
    const { data, error } = await supabase
      .from('coach_reviews')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data;
  },

  async updateReview(id: string, updates: any) {
    const { data, error } = await supabase
      .from('coach_reviews')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },
};
