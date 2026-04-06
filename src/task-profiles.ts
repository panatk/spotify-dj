import { TaskType, AudioParameters } from './types.js';

/**
 * Research-based audio parameter profiles for each task type.
 *
 * Sources:
 * - Yerkes-Dodson (1908): inverted-U relationship between arousal and performance
 * - Rauscher et al. (1993): spatial-temporal reasoning improvements with music
 * - Lesiuk (2005): positive mood and quality-of-work improvements with music
 * - Mehta et al. (2012): moderate ambient noise boosts creative cognition
 * - Perham & Currie (2014): instrumental music reduces interference for complex tasks
 * - Bottiroli et al. (2014): tempo/mode effects on cognitive task performance
 */

export const TASK_PROFILES: Record<TaskType, AudioParameters> = {
  'deep-focus': {
    minBPM: 60,
    maxBPM: 80,
    targetBPM: 70,
    instrumentalness: 0.9,
    energy: 0.25,
    valence: 0.3,
    mode: 0, // minor key reduces emotional salience, aids sustained attention
    acousticness: 0.5,
    danceability: 0.15,
  },
  'multitasking': {
    minBPM: 70,
    maxBPM: 90,
    targetBPM: 80,
    instrumentalness: 0.8,
    energy: 0.5,
    valence: 0.5,
    mode: 1,
    acousticness: 0.3,
    danceability: 0.4,
  },
  'creative': {
    minBPM: 100,
    maxBPM: 120,
    targetBPM: 110,
    instrumentalness: 0.7,
    energy: 0.65,
    valence: 0.6,
    mode: 1,
    acousticness: 0.25,
    danceability: 0.55,
  },
  'routine': {
    minBPM: 120,
    maxBPM: 140,
    targetBPM: 130,
    instrumentalness: 0.5,
    energy: 0.8,
    valence: 0.75,
    mode: 1,
    acousticness: 0.15,
    danceability: 0.7,
  },
  'energize': {
    minBPM: 120,
    maxBPM: 150,
    targetBPM: 135,
    instrumentalness: 0.3,
    energy: 0.9,
    valence: 0.85,
    mode: 1,
    acousticness: 0.1,
    danceability: 0.8,
  },
  'wind-down': {
    minBPM: 50,
    maxBPM: 65,
    targetBPM: 57,
    instrumentalness: 0.95,
    energy: 0.1,
    valence: 0.35,
    mode: 0, // minor key supports relaxation without excessive emotional salience
    acousticness: 0.7,
    danceability: 0.1,
  },
};

/**
 * Default genre seeds for each task type.
 * Spotify allows up to 5 seeds total (genres + tracks + artists).
 */
export const DEFAULT_GENRE_SEEDS: Record<TaskType, string[]> = {
  'deep-focus': ['ambient', 'classical', 'piano', 'minimal', 'new age'],
  'multitasking': ['electronic', 'downtempo', 'trip-hop', 'indie', 'chill'],
  'creative': ['indie', 'alternative', 'synth-pop', 'funk', 'jazz'],
  'routine': ['pop', 'dance', 'house', 'disco', 'electronic'],
  'energize': ['edm', 'hip-hop', 'rock', 'drum-and-bass', 'punk'],
  'wind-down': ['ambient', 'new age', 'classical', 'chill', 'acoustic'],
};

/**
 * Returns a human-readable rationale with science citations for why
 * a particular task type uses its specific parameters.
 */
export function profileRationale(task: TaskType): string {
  const rationales: Record<TaskType, string> = {
    'deep-focus': [
      'Deep focus: 60-80 BPM aligns with resting heart rate, promoting parasympathetic',
      'nervous system activation (Bernardi et al., 2006). Minor key reduces emotional',
      'salience for sustained attention. High instrumentalness (0.9) avoids linguistic',
      'interference with Broca\'s area (Perham & Currie, 2014). Low energy (0.25)',
      'minimises arousal to keep cognitive load available (Yerkes-Dodson, 1908).',
      '70% familiar tracks reduce cognitive load (Pereira et al., 2011).',
    ].join(' '),
    'multitasking': [
      'Multitasking: 70-90 BPM provides moderate arousal that supports task-switching',
      'without overwhelming working memory (Lesiuk, 2005). Instrumentalness of 0.8',
      'still avoids most lyrical interference. Balanced energy (0.5) and valence (0.5)',
      'maintain a neutral-positive mood conducive to context switching.',
    ].join(' '),
    'creative': [
      'Creative work: 100-120 BPM supplies moderate-high arousal that activates the',
      'default mode network associated with divergent thinking (Mehta et al., 2012).',
      'Higher valence (0.6) music correlates with more creative output (Rowe et al.,',
      '2007). Moderate instrumentalness (0.7) allows some vocal texture which can',
      'stimulate associative thinking.',
    ].join(' '),
    'routine': [
      'Routine tasks: 120-140 BPM and high energy (0.8) combat boredom during',
      'repetitive work by increasing arousal (Oldham et al., 1995). High valence',
      '(0.75) and moderate instrumentalness (0.5) allow enjoyable, familiar music',
      'since the cognitive demand is low and lyrics cause minimal interference.',
    ].join(' '),
    'energize': [
      'Energize: 120-150 BPM with very high energy (0.9) and valence (0.85)',
      'triggers sympathetic nervous system activation and dopamine release',
      '(Blood & Zatorre, 2001). Low instrumentalness (0.3) means vocals are',
      'welcome — singing along can boost mood. Ideal for pre-work motivation',
      'or overcoming an energy slump.',
    ].join(' '),
    'wind-down': [
      'Wind-down: 50-65 BPM with minimal energy (0.1) and near-total',
      'instrumentalness (0.95) supports the transition from active cognition',
      'to rest. This mirrors the "slow wave" auditory stimulation shown to',
      'enhance memory consolidation (Ngo et al., 2013). Slight minor-key',
      'tendency in valence (0.35) encourages relaxation without sadness.',
    ].join(' '),
  };

  return rationales[task];
}
