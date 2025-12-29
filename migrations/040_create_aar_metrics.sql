-- Migration: Create AAR Metrics Table
-- Stores detailed metrics for AAR reports (decision latency, coordination, compliance, etc.)

CREATE TABLE IF NOT EXISTS aar_metrics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  aar_report_id UUID NOT NULL REFERENCES aar_reports(id) ON DELETE CASCADE,
  metric_type TEXT NOT NULL, -- 'decision_latency', 'communication', 'coordination', 'compliance', etc.
  metric_name TEXT NOT NULL, -- Specific metric name (e.g., 'avg_latency_minutes', 'coordination_score')
  metric_value JSONB NOT NULL, -- Flexible structure for different metric types
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_aar_metrics_report_id ON aar_metrics(aar_report_id);
CREATE INDEX IF NOT EXISTS idx_aar_metrics_type ON aar_metrics(metric_type);
CREATE INDEX IF NOT EXISTS idx_aar_metrics_type_name ON aar_metrics(metric_type, metric_name);

-- Enable RLS
ALTER TABLE aar_metrics ENABLE ROW LEVEL SECURITY;

-- RLS Policies for aar_metrics
-- Session participants and trainers can view metrics for their sessions
CREATE POLICY "Session participants can view AAR metrics"
  ON aar_metrics FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM aar_reports ar
      JOIN session_participants sp ON sp.session_id = ar.session_id
      WHERE ar.id = aar_metrics.aar_report_id
      AND sp.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM aar_reports ar
      JOIN sessions s ON s.id = ar.session_id
      WHERE ar.id = aar_metrics.aar_report_id
      AND s.trainer_id = auth.uid()
    )
  );

-- Only trainers can insert metrics (through backend service)
CREATE POLICY "Trainers can create AAR metrics"
  ON aar_metrics FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM aar_reports ar
      JOIN sessions s ON s.id = ar.session_id
      WHERE ar.id = aar_metrics.aar_report_id
      AND s.trainer_id = auth.uid()
    )
  );

-- Comments
COMMENT ON TABLE aar_metrics IS 'Stores detailed metrics for AAR reports including decision latency, communication metrics, coordination scores, and compliance rates';
COMMENT ON COLUMN aar_metrics.metric_type IS 'Category of metric: decision_latency, communication, coordination, compliance, etc.';
COMMENT ON COLUMN aar_metrics.metric_name IS 'Specific name of the metric (e.g., avg_latency_minutes, total_messages, coordination_score)';
COMMENT ON COLUMN aar_metrics.metric_value IS 'JSONB value containing the metric data (can be number, object, array depending on metric type)';

