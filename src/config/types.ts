import { UUID } from '@elizaos/core';

export type PvPActionType = 'Silence' | 'Deafen' | 'Attack' | 'Poison';

// Base message types
export type MessageType = 'agent_message' | 'gm_message' | 'observation' | 'system_message';

export interface MessageHistoryEntry {
  timestamp: number;
  agentId: number;
  agentName: string;
  text: string;
}


// Action types
export interface RoundAction {
  roundId: number;
  outcome?: any;
}

// Config types
export interface BaseConfig {
  endpoint: string;
  roomId: number;
  creatorId: number;     // Database ID of the creator
}

