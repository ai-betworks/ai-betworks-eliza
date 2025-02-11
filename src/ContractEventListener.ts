import { elizaLogger } from '@elizaos/core';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import { AgentClient } from './clients/AgentClient';
import { Database, Tables } from './types/database.types';

export const supabase = createClient<Database>(process.env.PVPVAI_SUPABASE_URL!, process.env.PVPVAI_SUPABASE_ANON_KEY!);

export class ContractEventListener {
  private provider: ethers.Provider;
  private contract: ethers.Contract;
  private client: AgentClient;
  private isListening: boolean = false;

  constructor(contractAddress: string, contractABI: any, rpcUrl: string, client: AgentClient) {
    console.log('ContractEventListener constructor', contractAddress, rpcUrl);

    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.contract = new ethers.Contract(contractAddress, contractABI, this.provider);
    this.client = client;
  }

  private async fetchAgentsData(agentAddresses: string[]): Promise<Record<number, Partial<Tables<'agents'>>>> {
    const { data: agents, error } = await supabase
      .from('agents')
      .select('*')
      .in(
        'eth_wallet_address',
        agentAddresses.map(addr => addr.toLowerCase())
      );

    if (error) {
      elizaLogger.error('Error fetching agents data:', error);
      throw error;
    }

    return agents.reduce((acc, agent) => {
      acc[agent.id] = agent;
      return acc;
    }, {} as Record<number, Partial<Tables<'agents'>>>);
  }

  public async startListening(): Promise<void> {
    if (this.isListening) {
      return;
    }

    this.isListening = true;

    try {
      console.log('STARTING LISTENING FOR ALL CONTRACT EVENTS');
      // Listen for RoundStarted events
      this.contract.on(
        'RoundStarted',
        async (roundId: number, startBlockTimestamp: number, endBlockTimestamp: number) => {
          console.log('NEW ROUND STARTED: ', roundId, startBlockTimestamp, endBlockTimestamp);
          elizaLogger.log(`New round started: ${roundId} at ${startBlockTimestamp}, ending at ${endBlockTimestamp}`);

          try {
            // Get participating agents from contract
            const agentAddresses = await this.contract.getAgents();

            // Fetch agent data from database
            const agents = await this.fetchAgentsData(agentAddresses);

            // Update client's context with new round and agents
            this.client.context.currentRound = roundId;
            this.client.context.rounds[roundId] = {
              id: roundId,
              status: 'OPEN', //Is this open or starting?
              startedAt: startBlockTimestamp,
              endsAt: endBlockTimestamp,
              agents: agents,
            };
          } catch (error) {
            elizaLogger.error('Error processing RoundStarted event:', error);
          }
        }
      );

      // TODO Update round status in response to events

      elizaLogger.log('Started listening for RoundStarted events');
    } catch (error) {
      this.isListening = false;
      elizaLogger.error('Error starting event listener:', error);
      throw error;
    }
  }

  public stopListening(): void {
    if (!this.isListening) {
      return;
    }

    // Remove all event listeners
    this.contract.removeAllListeners();
    this.isListening = false;
    elizaLogger.log('Stopped listening for contract events');
  }
}
