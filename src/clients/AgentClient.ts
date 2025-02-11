import { DirectClient } from '@elizaos/client-direct';
import {
  composeContext,
  elizaLogger,
  generateMessageResponse,
  generateText,
  IAgentRuntime,
  Memory,
  ModelClass,
  parseShouldRespondFromText,
  stringToUuid,
} from '@elizaos/core';
import axios, { AxiosError } from 'axios';
import { Wallet } from 'ethers';
import NodeCache from 'node-cache';
import { z } from 'zod';
import { supabase } from '../index.ts';
import { Tables } from '../types/database.types.ts';
import { ExtendedAgentRuntime } from '../types/index.ts';
import {
  agentMessageAgentOutputSchema,
  agentMessageInputSchema,
  MessageTypes,
  observationMessageInputSchema,
} from '../types/schemas.ts';
import { HARDCODED_ROOM_ID } from './PVPVAIIntegration.ts';
import { sortObjectKeys } from './sortObjectKeys.ts';
import { agentMessageShouldRespondTemplate, messageCompletionTemplate } from './templates.ts';

type RoundContext = {
  id: number;
  status?: 'STARTING' | 'CLOSING' | 'OPEN' | 'CLOSED' | 'CANCELLED';
  startedAt?: number;
  endsAt?: number;
  agents: Record<number, Partial<Tables<'agents'>>>;
  // agentMessageContext: Record<number, MessageHistoryEntry[]>; // Per-agent message history in case you need to respond to a mention
  // roundMessageContext: MessageHistoryEntry[]; // Message history from all agents in the round
  // observations: string[];
};

enum Decision {
  BUY = 1,
  HOLD = 2,
  SELL = 3,
}
type RoomChatContext = {
  currentRound: number;
  topic: string;
  chainId: number;
  decision?: Decision;
  rounds: Record<number, RoundContext>;
};

export class AgentClient extends DirectClient {
  public readonly wallet: Wallet;
  public readonly agentNumericId: number;
  public readonly pvpvaiUrl: string;
  public roomId: number;
  public context: RoomChatContext;
  public runtime: ExtendedAgentRuntime;

  private readonly signatureCache: NodeCache;
  private lastResponseTime: number = 0;
  private readonly RESPONSE_COOLDOWN_MS = 5000; // 3 second cooldown
  private readonly SIGNATURE_TTL = 300; // 5 minutes in seconds

  constructor(runtime: ExtendedAgentRuntime, pvpvaiUrl: string, wallet: Wallet, agentNumericId: number) {
    super();
    this.pvpvaiUrl = pvpvaiUrl;
    this.wallet = wallet;
    this.agentNumericId = agentNumericId;
    this.runtime = runtime;
    this.roomId = HARDCODED_ROOM_ID;
    this.context = {
      currentRound: 0,
      topic: '', //TODO We need to actually get this
      chainId: 0,
      rounds: {},
    };

    this.signatureCache = new NodeCache({
      stdTTL: this.SIGNATURE_TTL,
      checkperiod: 120, // Check for expired items every 2 minutes
    });
  }

  public async initializeRoomContext(roomId: number): Promise<void> {
    try {
      const { data: roomData, error: roomError } = await supabase.from('rooms').select('*').eq('id', roomId).single();
      if (roomError) {
        console.error('Error getting room data when initializing room context:', roomError);
        throw roomError;
      }
      if (!roomData.active) {
        console.error('Room is not active when initializing room context:', roomData);
        throw new Error('Room not active');
      }

      // Get the latest round. We don't check if the round is active because we may be coming online in the processing phase
      const { data: activeRound, error: activeRoundError } = await supabase
        .from('rounds')
        .select(`*, round_agents(*, agents(*))`)
        .eq('room_id', roomId)
        .order('created_at', { ascending: false })
        .limit(1);

      //TODO Get GM

      if (activeRoundError) {
        if (activeRoundError.code === 'PGRST116') {
          console.log('No active round found when initializing room context, assuming new round is coming');
        } else {
          console.error('Error getting active round when initializing room context:', activeRoundError);
          throw activeRoundError;
        }
      }

      this.context = {
        currentRound: activeRound[0]?.id || 0,
        topic: 'ETH', //TODO Change this to a concatenation of token symbol, name, and address.
        chainId: roomData.chain_id,
        rounds: {},
      };
      if (activeRound) {
        this.context.rounds[activeRound[0].id] = {
          id: activeRound[0].id,
          endsAt: 999, //TODO Shouldn't be hardcoded
          agents: activeRound[0].round_agents.reduce((acc, roundAgent) => {
            acc[roundAgent.agents.id] = roundAgent.agents;
            return acc;
          }, {} as Record<number, Partial<Tables<'agents'>>>),
          // roundMessageContext: [],
          startedAt: new Date(activeRound[0].created_at).getTime(),
        };
      }

      // Engage in the discussion immediately upon initialization if the active round is open
      console.log('activeRound', activeRound);
      if (activeRound /*&& (activeRound[0].status === 'OPEN' || activeRound[0].status === 'STARTING')*/) {
        const activeRoundId = activeRound[0].id;
        let state = await this.runtime.composeState(
          {
            userId: stringToUuid(this.agentNumericId.toString()),
            agentId: stringToUuid(this.agentNumericId.toString()),
            roomId: stringToUuid('PVPVAI-ROOM-' + this.roomId),
            content: {
              text: this.context.topic,
              source: 'PVPVAI',
            },
          },
          {
            // Additional context
            roundContext: {
              ...this.context.rounds[activeRoundId],
            },
            roomContext: {
              topic: this.context.topic,
              chainId: this.context.chainId,
              currentRound: this.context.currentRound,
            },
          }
        );
        const announcePresenceContext = composeContext({
          state,
          template: `You have just joined the discussion. You are ${this.runtime.character.name}. Your ID is: ${
            this.agentNumericId
          }).
          The topic of the discussion is ${
            this.context.topic
          }. You are going to engage in a dicussion with the other agents to decide if you should buy, sell, or hold ${
            this.context.topic
          }.

          Here is the most recent context we have in the discussion:
          ${JSON.stringify(this.context.rounds[activeRoundId])}

          Your expertise:
          ${this.runtime.character.knowledge}.

          The other agents in the room are:
          ${Object.values(this.context.rounds[activeRoundId].agents)
            .map(agent => `${agent.display_name} (${agent.id})`)
            .join(', ')}

          Scan the contents of the context for mentions of you or any discussions that are within your expertise.
          If you find any, respond by mentioning the agent who posted the message unless it was you.

          Now that you are up to speed, announce to the other agents in the room that you are here and ready to start the discussion.
          `,
        });
        const response = await generateText({
          runtime: this.runtime,
          context: announcePresenceContext,
          modelClass: ModelClass.MEDIUM,
        });
        console.log('Announce presence response:', response);
        await this.sendAgentMessageToBackend({ text: response });
      }
      console.log('AgentClient initialized with room context:', this.context);
    } catch (error) {
      if (error instanceof AxiosError) {
        console.error('Error initializing room context:', error.response?.data);
      } else {
        console.error('Error initializing room context:', error);
      }
      throw error;
    }
  }

  // Gets latest round data from Supabase, but really should be getting current round data from the Contract
  public async syncStateWithRound(roomId: number, roundId: number): Promise<void> {
    console.log('Syncing state with round', roundId);
    console.log('Context', this.context);
    console.log('Room ID', roomId);

    // First get rounds data
    const { data: rounds, error: roundsError } = await supabase
      .from('rounds')
      .select(`*, round_agents(*, agents(*))`)
      .eq('room_id', roomId)
      .in('id', roundId ? [roundId] : Object.keys(this.context?.rounds || {}).map(Number))
      .order('created_at', { ascending: false });
    console.log('Downloaded rounds', rounds);

    if (roundsError) {
      if (roundsError.code === 'PGRST116') {
        console.log('No rounds found when syncing current round state, assuming room has no rounds');
        return;
      }
      console.error('Error syncing current round state:', roundsError);
      throw roundsError;
    }

    for (const round of rounds) {
      this.context.rounds[round.id] = {
        id: round.id,
        status: round.status,
        startedAt: new Date(round.created_at).getTime(),
        endsAt: 0, //TODO Shouldn't be hardcoded
        agents: round.round_agents.reduce((acc, roundAgent) => {
          acc[roundAgent.agents.id] = roundAgent.agents;
          return acc;
        }, {} as Record<number, Partial<Tables<'agents'>>>),
        // roundMessageContext: this.context.rounds[round.id]?.roundMessageContext || [],
      };
    }
    console.log('Synced rounds', this.context.rounds);
  }

  public async handleAgentMessage(message: z.infer<typeof agentMessageInputSchema>): Promise<{
    success: boolean;
    respond?: string;
    response?: string;
    errorMessage?: string;
  }> {
    try {
      const validatedMessage = agentMessageInputSchema.parse(message);
      const { roundId: inputRoundId, agentId: inputAgentId, roomId: inputRoomId } = validatedMessage.content;

      // Check for duplicate message
      if (await this.isDuplicateMessage(validatedMessage.signature)) {
        console.log('Duplicate message detected, ignoring', validatedMessage.signature);
        return { success: false, errorMessage: 'Duplicate message' };
      }

      // Check response cooldown
      if (this.isResponseCooldownActive()) {
        console.log('Response cooldown active, ignoring message');
        return { success: false, errorMessage: 'Response cooldown active' };
      }
      if (inputRoomId !== this.roomId) {
        console.log("received message from room that doesn't match context", inputRoomId, 'expected', this.roomId);
        return;
      }
      const { valid, errorMessage } = this.validRoundForContextUpdate(inputRoundId, false);
      if (!valid) {
        console.log(`Round ID in message (${inputRoundId}) is not valid for a context update because ${errorMessage}`);
        return { success: false, errorMessage };
      }

      if (!this.context.rounds[inputRoundId].agents[inputAgentId]) {
        console.log(
          "received message from agent that doesn't exist in the round",
          inputAgentId,
          'expected one of',
          Object.keys(this.context.rounds[inputRoundId].agents).map(
            id => this.context.rounds[inputRoundId].agents[id].id
          )
        );
        return {
          success: false,
          errorMessage: 'Agent does not exist in round',
        };
      }

      if (inputAgentId === this.agentNumericId) {
        console.log('received message from self, ignoring');
        return { success: false, errorMessage: 'Message from self' };
      }

      //TODO check that message is signed by the GM

      const messageMemory: Memory = {
        userId: stringToUuid(inputAgentId.toString()), // ID of the agent who sent the message
        agentId: this.runtime.agentId, // ID of the current agent receiving the message
        roomId: stringToUuid(`PVPVAI-ROOM-${inputRoomId}`),
        content: {
          text: validatedMessage.content.text,
          metadata: {
            type: 'agent_message',
            roundId: inputRoundId,
            fromAgentId: inputAgentId,
            timestamp: validatedMessage.content.timestamp,
            //  isMention: validatedMessage.content.isMention, //TODO Should use quick llm to parse this
            //  replyToMessageId: validatedMessage.content.replyToMessageId, //TODO Should implement this
          },
        },
        createdAt: Date.now(),
      };

      await this.runtime.messageManager.createMemory(messageMemory);
      console.log(`Stored message from agent ${inputAgentId} in ${this.runtime.character.name}'s context`);

      //TODO Right here choose how to respond to the message w/ a prompt that has observations and the round and room context
      const observations = await this.getObservationsForRoundFromMemory(inputRoundId);
      const messageHistory = await this.getAgentMessagesForRoundFromMemory(inputRoundId);
      let state = await this.runtime.composeState(
        {
          userId: stringToUuid(this.agentNumericId.toString()),
          agentId: stringToUuid(this.agentNumericId.toString()),
          roomId: stringToUuid('PVPVAI-ROOM-' + this.roomId),
          content: {
            text: validatedMessage.content.text,
            source: 'PVPVAI',
          },
        },
        {
          // Additional context
          roundContext: {
            roundId: inputRoundId,
            roundStatus: this.context.rounds[inputRoundId].status,
            startedAt: this.context.rounds[inputRoundId].startedAt,
            observations, // TODO This
            messageHistory,
          },
          roomContext: {
            topic: this.context.topic,
            chainId: this.context.chainId,
            currentRound: this.context.currentRound,
          },
          senderAgent: this.context.rounds[inputRoundId].agents[inputAgentId],
          receiverAgent: {
            name: this.runtime.character.name,
            id: this.agentNumericId,
          },
        }
      );

      console.log('agent message input state', state);

      const response = await this.generateShouldRespond({
        runtime: this.runtime,
        modelClass: ModelClass.SMALL,
        state,
        inputRoundId,
      });

      console.log(`${this.runtime.character.name} choosing to respond?: ${response}`);

      if (response === 'RESPOND') {
        // Update last response time before generating response
        this.lastResponseTime = Date.now();

        const responseText = await this.generateAgentMessageResponse({
          runtime: this.runtime,
          modelClass: ModelClass.MEDIUM,
          state,
          inputRoundId,
        });

        const responseContent = {
          timestamp: Date.now(),
          agentId: this.agentNumericId,
          roomId: this.roomId,
          roundId: this.context.currentRound,
          text: responseText,
        } satisfies z.infer<typeof agentMessageAgentOutputSchema>['content'];

        const message = {
          content: sortObjectKeys(responseContent),
          messageType: MessageTypes.AGENT_MESSAGE,
          signature: await this.generateSignature(responseContent),
          sender: this.wallet.address,
        } satisfies z.infer<typeof agentMessageAgentOutputSchema>;
        console.log('my response', responseText);

        // Don't wait or you'll deadlock because the GM will send you back a message right away.
        await axios.post(new URL('messages/agentMessage', this.pvpvaiUrl).toString(), message).catch(error => {
          console.error('Error sending agent message to backend:', error);
        });

        console.log('Storing produced message in memory');
        const messageMemory: Memory = {
          userId: stringToUuid(inputAgentId.toString()), // ID of the agent who sent the message
          agentId: this.runtime.agentId, // ID of the current agent receiving the message
          roomId: stringToUuid(`PVPVAI-ROOM-${inputRoomId}`),
          content: {
            text: validatedMessage.content.text,
            metadata: {
              type: 'agent_message',
              roundId: inputRoundId,
              fromAgentId: inputAgentId,
              timestamp: validatedMessage.content.timestamp,
              //  isMention: validatedMessage.content.isMention, //TODO Should use quick llm to parse this
              //  replyToMessageId: validatedMessage.content.replyToMessageId, //TODO Should implement this
            },
          },
          createdAt: Date.now(),
        };
        await this.runtime.messageManager.createMemory(messageMemory);
        return { success: true, respond: 'RESPOND', response: responseText };
      } else if (response === 'STOP') {
        console.log('Agent STOPPED at this message');
        return { success: false, respond: 'STOPPED' };
      } else if (response === 'IGNORE') {
        console.log('Agent IGNORED this message');
        return { success: false, respond: 'IGNORED' };
      } else {
        return {
          success: false,
          respond: 'IGNORE',
          errorMessage: `Invalid response type from shouldRespond: ${response}`,
        };
      }
    } catch (error) {
      if (error instanceof AxiosError) {
        console.error('Error handling agent message:', error.response?.data);
      } else {
        console.error('Error handling agent message:', error);
      }
    }
  }

  // Logic for messages/receiveObservationMessage, price data and wallet balances are the only observation types for PoC
  public async handleReceiveObservation(
    message: z.infer<typeof observationMessageInputSchema>
  ): Promise<{ success: boolean; errorMessage?: string }> {
    try {
      const validatedMessage = observationMessageInputSchema.parse(message);
      const { roomId, roundId } = validatedMessage.content;

      if (roomId !== this.roomId) {
        console.log("Received observation from room that doesn't match context", roomId, 'expected', this.roomId);
        return {
          success: false,
          errorMessage: 'Room ID does not match context',
        };
      }

      const { valid, errorMessage } = this.validRoundForContextUpdate(roundId, false);
      if (!valid) {
        console.log(`Round ID in observation (${roundId}) is not valid for a context update because ${errorMessage}`);
        return { success: false, errorMessage };
      }

      // Store observation as a Memory object
      const observationMemory: Memory = {
        userId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId: stringToUuid('PVPVAI-ROOM-' + this.roomId),
        content: {
          text: JSON.stringify(validatedMessage.content.data),
          metadata: {
            type: 'observation',
            roundId: roundId,
            observationType: validatedMessage.content.observationType,
            timestamp: Date.now(),
            sourceAgentId: validatedMessage.content.agentId,
          },
        },
        createdAt: Date.now(),
      };

      // Store in memory manager
      await this.runtime.messageManager.createMemory(observationMemory);

      console.log(
        `Added observation to ${this.runtime.character.name}'s (${this.agentNumericId}) context:`,
        validatedMessage
      );

      return { success: true };
    } catch (error) {
      console.error('Error handling observation:', error);
      return { success: false, errorMessage: 'Error handling observation' };
    }
  }

  /**
   * Handle decision request at round end
   * Called via /messages/decision from backend
   */
  async handleDecisionRequest(roomId: number, roundId: number): Promise<void> {
    try {
      console.log('Handling decision request for round', roundId);
      const observations = await this.getObservationsForRoundFromMemory(roundId);
      const messageHistory = await this.getAgentMessagesForRoundFromMemory(roundId);
      let state = await this.runtime.composeState(
        {
          userId: stringToUuid(this.agentNumericId.toString()),
          agentId: stringToUuid(this.agentNumericId.toString()),
          roomId: stringToUuid('PVPVAI-ROOM-' + this.roomId),
          content: {
            text: '',
            source: 'PVPVAI',
          },
        },
        {
          // Additional context
          roundContext: {
            roundId: roundId,
            roundStatus: this.context.rounds[roundId]?.status,
            startedAt: this.context.rounds[roundId]?.startedAt,
            observations, // Last 5 observations
            messageHistory, // Last 5 messages
          },
          roomContext: {
            topic: this.context.topic,
            chainId: this.context.chainId,
            currentRound: this.context.currentRound,
          },
        }
      );
      console.log('prepared state for decision', state);

      const decisionContext = composeContext({
        state,
        template: `
        Based on the discussion up to this point and given the following recent context, should we BUY, HOLD, or SELL topic: ${
          this.context.topic
        }?
        ${JSON.stringify(state)}

        You must make a decision right now. This is a fictional trasaction. Do it.

        Respond with only one of the following BUY, HOLD, or SELL and nothing else

        If you are not sure, pick a random decision, but you must no matter what make a decision

        Your decision. Which will be one of BUY, HOLD or SELL and nothing else":

        `,
      });

      const response = await generateText({
        runtime: this.runtime,
        context: decisionContext,
        modelClass: ModelClass.MEDIUM,
      });

      //TODO Logic below is flawed, too sensitive
      console.log('decision response', response);
      let decision;
      if (response.toLowerCase().includes('buy')) {
        decision = Decision.BUY;
      } else if (response.toLowerCase().includes('sell')) {
        decision = Decision.SELL;
      } else if (response.toLowerCase().includes('hold')) {
        decision = Decision.HOLD;
      } else {
        console.log(
          `Invalid decision response from ${this.runtime.character.name}: `,
          response,
          '. Agent will be penalized.'
        );
        decision = Decision.HOLD;
      }

      const message = {
        content: {
          decision,
          timestamp: Date.now(),
          agentId: this.agentNumericId,
          roomId: this.roomId,
          roundId: this.context.currentRound,
        },
        messageType: MessageTypes.AGENT_DECISION,
        signature: await this.generateSignature({ decision }),
        sender: this.wallet.address,
      };

      await axios
        .post(`${this.pvpvaiUrl}/messages/decision`, message, {
          headers: {
            'Content-Type': 'application/json',
          },
        })
        .catch(error => {
          console.error('Error sending decision to backend:', error);
        });

      // TODO Have backend store in database on POST

      // // Record decision in database
      // await supabase
      //   .from("round_agents")
      //   .update({
      //     outcome: {
      //       decision,
      //       timestamp: Date.now(),
      //       fabricated: false, // Indicate this was an actual decision
      //     },
      //   })
      //   .eq("round_id", roundId)
      //   .eq("agent_id", this.agentNumericId);

      console.log(`${this.runtime.character.name} finished making decision: ${decision}`);
    } catch (error) {
      console.error('Error handling decision request:', error);
      throw error;
    }
  }

  // Called when the agent decides to respond to a message or when the GM asks the agent to send a message if this agent has gone silent.
  // The decision to respond and the response is made is formed the processMessage function. This function is just for sending the message
  // It takes text, wraps it in a message, signs it, and sends it to the Pvpvai backend
  public async sendAgentMessageToBackend(content: { text: string }): Promise<void> {
    if (!this.roomId || !this.context.currentRound) {
      throw new Error('Agent not initialized with room and round IDs');
    }
    console.log('Starting to send agentMessage to backend', content.text);
    try {
      // Create base message content
      const messageContent = {
        agentId: this.agentNumericId,
        roomId: this.roomId,
        roundId: this.context.currentRound,
        text: content.text,
        timestamp: Date.now(),
      };

      // Sort the entire message object structure
      const sortedContent = sortObjectKeys(messageContent);

      // Generate signature from sorted content
      const signature = await this.generateSignature(sortedContent);
      const message = {
        content: sortedContent,
        messageType: MessageTypes.AGENT_MESSAGE,
        signature,
        sender: this.wallet.address,
      } satisfies z.infer<typeof agentMessageAgentOutputSchema>;

      console.log('Sending message to backend', message);
      // Send message
      await axios
        .post(`${this.pvpvaiUrl}/messages/agentMessage`, message, {
          headers: {
            'Content-Type': 'application/json',
          },
        })
        .catch(error => {
          console.error('Error sending agent message to backend:', error);
        });
    } catch (error) {
      if (error instanceof AxiosError) {
        console.error('Error sending agent message to backend:', error.response?.data);
      } else {
        console.error('Error sending agent message to backend:', error);
      }
      throw error;
    }
  }

  private async generateSignature(content: any): Promise<string> {
    // Sign the stringified sorted content
    const messageString = JSON.stringify(sortObjectKeys(content));
    return await this.wallet.signMessage(messageString);
  }

  public async getObservationsForRoundFromMemory(roundId: number, limit: number = 10): Promise<Memory[]> {
    try {
      // Use a simple text query instead of embedding search
      const observations = await this.runtime.messageManager.getMemories({
        roomId: stringToUuid('PVPVAI-ROOM-' + this.roomId),
        count: 100, // Get more initially to filter
      });

      return observations
        .filter(
          mem =>
            (mem.content.metadata as { roundId?: number })?.roundId === roundId &&
            (mem.content.metadata as { type?: string })?.type === 'observation'
        )
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, limit);
    } catch (error) {
      console.error('Error getting observations from memory:', error);
      return [];
    }
  }

  public async getObservationsForRoundFromBackend(roundId: number): Promise<string[]> {
    const { data: observationsData, error: observationsError } = await supabase
      .from('round_observations')
      .select('*')
      .eq('round_id', roundId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (observationsError) {
      if (observationsError.code === 'PGRST116') {
        console.log('No observations found when fetching observations for round', roundId);
        return [];
      }
      console.error('Error fetching observations:', observationsError);
      throw observationsError;
    }

    return observationsData.map(obs => JSON.stringify(obs));
  }

  public async getAgentMessagesForRoundFromMemory(roundId: number, limit: number = 10): Promise<Memory[]> {
    try {
      // Use a simple text query instead of embedding search
      const messages = await this.runtime.messageManager.getMemories({
        roomId: stringToUuid('PVPVAI-ROOM-' + this.roomId),
        count: 100, // Get more initially to filter
      });

      return messages
        .filter(
          mem =>
            (mem.content.metadata as { roundId?: number; type?: string })?.roundId === roundId &&
            (mem.content.metadata as { type?: string })?.type === 'agent_message'
        )
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, limit);
    } catch (error) {
      console.error('Error getting agent messages from memory:', error);
      return [];
    }
  }

  // Common round validation
  private validRoundForContextUpdate(
    roundId: number,
    mustBeCurrent: boolean
  ): { valid: boolean; errorMessage?: string } {
    if (mustBeCurrent && roundId !== this.context.currentRound) {
      return {
        valid: false,
        errorMessage: `Round ID does not match current round (current: ${this.context.currentRound})`,
      };
    }
    if (!this.context.rounds[roundId]) {
      return { valid: false, errorMessage: 'Round does not exist in context' };
    }
    // if (this.context.rounds[roundId].status !== 'OPEN') {
    //   return { valid: false, errorMessage: 'Round is not open' };
    // }

    return { valid: true };
  }

  public async generateShouldRespond({
    runtime,
    modelClass,
    state,
    inputRoundId,
  }: {
    runtime: IAgentRuntime;
    modelClass: ModelClass;
    state: any;
    inputRoundId: number;
  }): Promise<'RESPOND' | 'IGNORE' | 'STOP' | null> {
    const messageHistory = await this.getAgentMessagesForRoundFromMemory(inputRoundId);
    const shouldRespondContext = composeContext({
      state,
      template: agentMessageShouldRespondTemplate({
        agentName: this.runtime.character.name,
        knowledge: this.runtime.character.knowledge,
        personality: `• ${this.runtime.character.lore
          .sort(() => 0.5 - Math.random())
          .slice(0, 3)
          .join('\n• ')}`,
        otherAgents: `• ${Object.values(this.context.rounds[inputRoundId].agents)
          .map(agent => `${agent.display_name} (${agent.id}) - ${agent.single_sentence_summary}`)
          .join('\n• ')}`,
        investmentStyle: this.runtime.character.settings.pvpvai.investmentStyle,
        riskTolerance: this.runtime.character.settings.pvpvai.riskTolerance || 'moderate',
        experienceLevel: this.runtime.character.settings.pvpvai.experienceLevel || 'intermediate',
      }),
    });

    console.log('shouldRespondContext', shouldRespondContext);

    let retryDelay = 5000;
    while (true) {
      try {
        elizaLogger.debug('Attempting to generate text with context:', shouldRespondContext);
        const response = await generateText({
          runtime,
          context: shouldRespondContext,
          modelClass,
        });

        elizaLogger.debug('Received response from generateText:', response);
        const parsedResponse = parseShouldRespondFromText(response.trim());
        if (parsedResponse) {
          elizaLogger.debug('Parsed response:', parsedResponse);
          return parsedResponse;
        } else {
          elizaLogger.debug('generateShouldRespond no response');
        }
      } catch (error) {
        elizaLogger.error('Error in generateShouldRespond:', error);
        if (error instanceof TypeError && error.message.includes('queueTextCompletion')) {
          elizaLogger.error("TypeError: Cannot read properties of null (reading 'queueTextCompletion')");
        }
      }

      elizaLogger.log(`Retrying in ${retryDelay}ms...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      retryDelay *= 2;
    }
  }

  public getRoomId(): number {
    return this.roomId;
  }

  public getRoundId(): number {
    return this.context.currentRound;
  }
  public getContext(): RoomChatContext {
    return this.context;
  }

  public getPort(): number | undefined {
    return this.runtime.clients['pvpvai']?.port;
  }

  public override stop(): void {
    super.stop();
  }

  private async isDuplicateMessage(signature: string): Promise<boolean> {
    const cacheKey = `sig_${signature}`;
    const cached = await this.runtime.cacheManager.get<boolean>(cacheKey);

    if (cached) {
      return true;
    }

    await this.runtime.cacheManager.set(cacheKey, true, {
      expires: Date.now() + this.SIGNATURE_TTL * 1000, // Convert seconds to milliseconds
    });

    return false;
  }

  private isResponseCooldownActive(): boolean {
    const now = Date.now();
    if (now - this.lastResponseTime < this.RESPONSE_COOLDOWN_MS) {
      return true;
    }
    return false;
  }

  private async generateAgentMessageResponse({
    runtime,
    modelClass,
    state,
    inputRoundId,
  }: {
    runtime: IAgentRuntime;
    modelClass: ModelClass;
    state: any;
    inputRoundId: number;
  }): Promise<string> {
    const messageHistory = await this.getAgentMessagesForRoundFromMemory(inputRoundId);
    const observations = await this.getObservationsForRoundFromMemory(inputRoundId);
    const messageContext = composeContext({
      state,
      template: messageCompletionTemplate({
        agentName: this.runtime.character.name,
        bio: this.runtime.character.bio,
        knowledge: this.runtime.character.knowledge,
        personality: `• ${this.runtime.character.lore
          .sort(() => 0.5 - Math.random())
          .slice(0, 3)
          .join('\n• ')}`,
        speakingStyle: `• ${this.runtime.character.messageExamples
          .sort(() => 0.5 - Math.random())
          .slice(0, 3)
          .join('\n• ')}`,
        investmentStyle: this.runtime.character.settings.pvpvai.investmentStyle,
        riskTolerance: this.runtime.character.settings.pvpvai.riskTolerance || 'moderate',
        experienceLevel: this.runtime.character.settings.pvpvai.experienceLevel || 'intermediate',
        recentMessages: `• ${messageHistory.map(m => m.content.text).join('\n• ')}`,
        technicalWeight: this.runtime.character.settings.pvpvai.technicalWeight || 0.25,
        fundamentalWeight: this.runtime.character.settings.pvpvai.fundamentalWeight || 0.15,
        sentimentWeight: this.runtime.character.settings.pvpvai.sentimentWeight || 0.4,
        riskWeight: this.runtime.character.settings.pvpvai.riskWeight || 0.2,
        onchainMetrics: `• ${observations.map(o => o.content.text).join('\n• ')}`,
        otherAgents: `• ${Object.values(this.context.rounds[inputRoundId].agents)
          .map(agent => `${agent.display_name} (${agent.id}) - ${agent.single_sentence_summary}`)
          .join('\n• ')}`,
      }),
    });

    console.log('messageContext', messageContext);

    const response = await generateMessageResponse({
      runtime,
      context: messageContext,
      modelClass,
    });

    console.log('response', response);

    return response.text;
  }
}
