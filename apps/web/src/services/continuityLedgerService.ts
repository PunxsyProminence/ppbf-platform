import { supabase } from '@/lib/supabase';

export const continuityLedgerService = {
  async recordEntry(entry: any) {
    const { data, error } = await supabase
      .from('continuity_ledger')
      .insert(entry)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async getUserLedger(userId: string) {
    const { data, error } = await supabase
      .from('continuity_ledger')
      .select('*')
      .eq('user_id', userId)
      .order('timestamp', { ascending: false });
    if (error) throw error;
    return data;
  },
};
