// Shared types between Express server and React client.
// No Node.js imports — safe in both server and browser contexts.

export type SourcePlatform = 'tiktok' | 'youtube' | 'podcast' | 'web' | 'other';
export type SourceTopic    = 'geopolitical' | 'economic' | 'technology' | 'social' | 'energy' | 'other';
export type SourceTier     = 'unverified' | 'social' | 'news' | 'primary';

export interface AdminHumanIntelRecord {
  id:              string;
  submitted_at:    string;
  source_platform: SourcePlatform;
  source_url?:     string;
  raw_text:        string;
  extracted: {
    title:      string;
    topic:      SourceTopic;
    countries:  string[];
    actors:     string[];
    event_type: string | null;
    confidence: number;
    tags:       string[];
  };
  credibility: {
    source_tier:      SourceTier;
    bias_flags:       string[];
    cross_references: string[];
    assessment:       string;
  };
  follow_up_requests:       string[];
  economist_quick_analysis: string;
  exported:                 boolean;
}

export interface ActorGoal {
  name:        string;
  stated_goal: string;
  real_goal:   string;
  red_lines:   string;
}

export interface BlocPerspective {
  bloc:             string;
  how_they_see_it:  string;
  their_interest:   string;
  internal_tension: string;
}

export interface EventAnalysis {
  event_id:           string;
  what_happened:      string;
  historical_context: string;
  political_analysis: string;
  social_analysis:    string;
  actor_goals:        ActorGoal[];
  bloc_perspectives:  BlocPerspective[];
  what_to_watch:      string[];
  confidence: {
    score:     number;
    reasoning: string;
  };
  created_at:  string;
  last_edited: string;
  reviewed:    boolean;
}

export interface AlignmentMap {
  primary_alignment:  string;
  secondary_ties:     string;
  internal_factions:  string;
  fault_lines:        string;
}

export interface CountryBrief {
  iso3:               string;
  situation_overview: string;
  key_dynamics:       string;
  historical_roots:   string;
  actor_map:          string;
  alignment_map:      AlignmentMap;
  watchlist:          string[];
  last_reviewed:      string;
  last_synthesized:   string;
}
