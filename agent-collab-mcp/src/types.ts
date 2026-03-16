export interface TaskRow {
  id: string;
  title: string;
  status: string;
  owner: string;
  depends_on: string | null;
  context: string | null;
  acceptance: string | null;
  plan: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewRow {
  round: number;
  verdict: string;
  issues: string | null;
  notes: string | null;
  created_at: string;
}

export interface ContextRow {
  key: string;
  content: string;
  updated_at: string;
}

export interface CountRow {
  status: string;
  cnt: number;
}

export interface ActivityRow {
  timestamp: string;
  agent: string;
  action: string;
}

export interface EpicRow {
  id: string;
  name: string;
  description: string | null;
  summary: string | null;
  strategy: string | null;
  engine_mode: string | null;
  task_count: number;
  context_json: string | null;
  activity_json: string | null;
  created_at: string;
  archived_at: string;
}

export interface EpicTaskRow {
  task_id: string;
  title: string;
  status: string;
  owner: string | null;
  context: string | null;
  acceptance: string | null;
  plan: string | null;
  reviews_json: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface Issue {
  file?: string;
  line?: number;
  description: string;
  severity?: "critical" | "warning" | "note";
}
