-- Migration 167: Social crisis doctrine cache
-- Caches researched doctrines and best practices for social media crisis response teams.
-- Avoids re-researching the same UNESCO/Christchurch Call/IMDA guidelines every scenario generation.
-- Keyed by team_role_type (normalized) so "Social Media Monitoring" doctrines are reused across scenarios.

CREATE TABLE IF NOT EXISTS social_crisis_doctrines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_role_type TEXT NOT NULL,
  crisis_category TEXT NOT NULL DEFAULT 'social_media_crisis',
  guidelines JSONB NOT NULL DEFAULT '[]',
  source_basis TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(team_role_type, crisis_category)
);

CREATE TABLE IF NOT EXISTS social_crisis_group_doctrines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  crisis_category TEXT NOT NULL DEFAULT 'social_media_crisis',
  coordination_guidelines JSONB NOT NULL DEFAULT '[]',
  escalation_protocols JSONB NOT NULL DEFAULT '[]',
  timing_benchmarks JSONB NOT NULL DEFAULT '{}',
  case_studies JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(crisis_category)
);

CREATE TABLE IF NOT EXISTS social_crisis_benchmarks_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  crisis_category TEXT NOT NULL DEFAULT 'social_media_crisis',
  benchmarks JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(crisis_category)
);

CREATE INDEX IF NOT EXISTS idx_social_doctrines_role ON social_crisis_doctrines(team_role_type);
CREATE INDEX IF NOT EXISTS idx_social_doctrines_category ON social_crisis_doctrines(crisis_category);

CREATE TRIGGER update_social_crisis_doctrines_updated_at BEFORE UPDATE ON social_crisis_doctrines
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_social_crisis_group_doctrines_updated_at BEFORE UPDATE ON social_crisis_group_doctrines
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_social_crisis_benchmarks_cache_updated_at BEFORE UPDATE ON social_crisis_benchmarks_cache
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
