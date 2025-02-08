import { DirectClient } from "@elizaos/client-direct";
import { composeContext, stringToUuid } from "@elizaos/core";
import axios, { AxiosError } from "axios";
import { Wallet } from "ethers";
import { z } from "zod";
import { MessageHistoryEntry } from "../config/types.ts";
import { supabase } from "../index.ts";
import { Tables } from "../types/database.types.ts";
import { ExtendedAgentRuntime } from "../types/index.ts";
import {
  agentMessageAgentOutputSchema,
  agentMessageInputSchema,
  MessageTypes,
  observationMessageInputSchema,
} from "../types/schemas.ts";
import { HARDCODED_ROOM_ID } from "./PVPVAIIntegration.ts";
import { sortObjectKeys } from "./sortObjectKeys.ts";
import { agentMessageShouldRespondTemplate } from "./templates.ts";

enum RoundStatus {
  NONE = 0,
  OPEN = 1,
  PROCESSING = 2,
  COMPLETED = 3,
}

interface RoundResponse {
  // for get active rounds
  success: boolean;
  data?: {
    id: number;
    room_id: number;
    active: boolean;
    [key: string]: any; // For other round fields
  };
  error?: string;
}
type RoundContext = {
  id: number;
  status: string;
  startedAt: number;
  agents: Record<number, Partial<Tables<"agents">>>;
  // agentMessageContext: Record<number, MessageHistoryEntry[]>; // Per-agent message history in case you need to respond to a mention
  roundMessageContext: MessageHistoryEntry[]; // Message history from all agents in the round
  observations: string[];
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
  maxNumObservationsContext: number;
  maxNumAgentMessageContext: number;
  rounds: Record<number, RoundContext>;
  decision?: Decision;
};

type AgentMessageState = {
  userId: string;
  agentId: number;
  roomId: number;
  content: {
    text: string;
    source: string;
  };
  roundContext: {
    roundId: number;
    roundStatus: string;
    startedAt: number;
    observations: string[];
    messageHistory: MessageHistoryEntry[];
  };
  roomContext: {
    topic: string;
    chainId: number;
    currentRound: number;
  };
  senderAgent: Partial<Tables<"agents">>;
  receiverAgent: {
    name: string;
    id: number;
  };
};

export class AgentClient extends DirectClient {
  private readonly wallet: Wallet;
  private readonly agentNumericId: number;
  private readonly pvpvaiUrl: string;
  private roomId: number;
  private context: RoomChatContext;
  private isActive: boolean;
  private runtime: ExtendedAgentRuntime;

  // Add PvP status tracking
  private activePvPEffects: Map<string, any> = new Map();

  // Add these properties after the existing private properties
  private messageContext: MessageHistoryEntry[] = [];
  private readonly MAX_CONTEXT_SIZE = 8;

  constructor(
    runtime: ExtendedAgentRuntime,
    pvpvaiUrl: string,
    wallet: Wallet,
    agentNumericId: number
  ) {
    super();
    this.pvpvaiUrl = pvpvaiUrl;
    this.wallet = wallet;
    this.agentNumericId = agentNumericId;
    this.runtime = runtime;
    this.roomId = HARDCODED_ROOM_ID;
    this.isActive = true;
    this.context = {
      currentRound: 0,
      topic: "",
      chainId: 0,
      maxNumObservationsContext: 10,
      maxNumAgentMessageContext: 10,
      rounds: {},
    };
  }

  public async initializeRoomContext(roomId: number): Promise<void> {
    const { data: roomData, error: roomError } = await supabase
      .from("rooms")
      .select("*")
      .eq("id", roomId)
      .single();
    if (roomError) {
      console.error(
        "Error getting room data when initializing room context:",
        roomError
      );
      throw roomError;
    }
    if (!roomData.active) {
      console.error(
        "Room is not active when initializing room context:",
        roomData
      );
      throw new Error("Room not active");
    }

    // Get the latest round. We don't check if the round is active because we may be coming online in the processing phase
    const { data: activeRound, error: activeRoundError } = await supabase
      .from("rounds")
      .select(`*, round_agents(*, agents(*))`)
      .eq("room_id", roomId)
      .order("created_at", { ascending: false })
      .limit(1);
    // .single();
    console.log("activeRound", activeRound);

    //TODO Get GM

    if (activeRoundError) {
      if (activeRoundError.code === "PGRST116") {
        console.log(
          "No active round found when initializing room context, assuming new round is coming"
        );
      } else {
        console.error(
          "Error getting active round when initializing room context:",
          activeRoundError
        );
        throw activeRoundError;
      }
    }

    this.context = {
      currentRound: activeRound[0]?.id || 0,
      topic: "ETH", //TODO Change this to a concatenation of token symbol, name, and address.
      chainId: roomData.chain_id,
      maxNumObservationsContext: 30,
      maxNumAgentMessageContext: 10,
      rounds: {},
    };
    if (activeRound) {
      this.context.rounds[activeRound[0].id] = {
        id: activeRound[0].id,
        status: activeRound[0].status,
        agents: activeRound[0].round_agents.reduce((acc, roundAgent) => {
          acc[roundAgent.agents.id] = roundAgent.agents;
          return acc;
        }, {} as Record<number, Partial<Tables<"agents">>>),
        roundMessageContext: [],
        observations: [],
        startedAt: new Date(activeRound[0].created_at).getTime(),
      };
    }
  }

  public async syncCurrentRoundState(
    roomId: number,
    roundId?: number
  ): Promise<void> {
    // First get rounds data
    const { data: rounds, error: roundsError } = await supabase
      .from("rounds")
      .select(`*, agents(*)`)
      .eq("room_id", roomId)
      .in(
        "id",
        roundId ? [roundId] : Object.keys(this.context.rounds).map(Number)
      )
      .order("created_at", { ascending: false });

    if (roundsError) {
      if (roundsError.code === "PGRST116") {
        console.log(
          "No rounds found when syncing current round state, assuming room has no rounds"
        );
        return;
      }
      throw roundsError;
    }

    for (const round of rounds) {
      let observations = this.context.rounds[round.id]?.observations || [];
      if (round.status === "OPEN") {
        // If the round is the current round, sync observations in case you missed any
        observations = await this.getObservationsForRoundFromBackend(round.id);
      }

      this.context.rounds[round.id] = {
        id: round.id,
        status: round.status,
        agents: round.agents,
        roundMessageContext:
          this.context.rounds[round.id]?.roundMessageContext || [],
        observations,
        startedAt: new Date(round.created_at).getTime(),
      };
    }
  }

  // Called when the agent decides to respond to a message or when the GM asks the agent to send a message if this agent has gone silent.
  // The decision to respond and the response is made is formed the processMessage function. This function is just for sending the message
  // It takes text, wraps it in a message, signs it, and sends it to the Pvpvai backend
  public async sendAIMessage(content: { text: string }): Promise<void> {
    if (!this.roomId || !this.context.currentRound) {
      throw new Error("Agent not initialized with room and round IDs");
    }

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

      // Send message
      await axios.post(`${this.pvpvaiUrl}/messages/agentMessage`, message, {
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      if (error instanceof AxiosError) {
        console.error(
          "Error sending agent message to backend:",
          error.response?.data
        );
      } else {
        console.error("Error sending agent message to backend:", error);
      }
      throw error;
    }
  }

  private async generateSignature(content: any): Promise<string> {
    // Sign the stringified sorted content
    const messageString = JSON.stringify(sortObjectKeys(content));
    console.log("Agent signing message:", messageString);
    return await this.wallet.signMessage(messageString);
  }

  public async handleAgentMessage(
    message: z.infer<typeof agentMessageInputSchema>
  ): Promise<{ success: boolean; errorMessage?: string }> {
    try {
      const validatedMessage = agentMessageInputSchema.parse(message);
      const {
        roundId: inputRoundId,
        agentId: inputAgentId,
        roomId: inputRoomId,
      } = validatedMessage.content;

      const { valid, errorMessage } = this.validRoundForContextUpdate(
        inputRoundId,
        true
      );
      if (!valid) {
        console.log(
          `Round ID in message (${inputRoundId}) is not valid for a context update because ${errorMessage}`
        );
        return { success: false, errorMessage };
      }
      console.log(this.context.rounds[inputRoundId].agents[inputAgentId]);
      console.log(
        Object.keys(this.context.rounds[inputRoundId].agents).find(
          (id) =>
            this.context.rounds[inputRoundId].agents[id].id === inputAgentId
        )
      );
      if (!this.context.rounds[inputRoundId].agents[inputAgentId]) {
        console.log(
          "received message from agent that doesn't exist in the round",
          inputAgentId,
          "expected one of",
          Object.keys(this.context.rounds[inputRoundId].agents).map(
            (id) => this.context.rounds[inputRoundId].agents[id].id
          )
        );
        return {
          success: false,
          errorMessage: "Agent does not exist in round",
        };
      }
      //TODO check kicked

      if (this.context.rounds[inputRoundId].status !== "OPEN") {
        console.log(
          "received message from round that is not open",
          inputRoundId
        );
        return { success: false, errorMessage: "Round is not open" };
      }
      if (inputAgentId === this.agentNumericId) {
        console.log("received message from self, ignoring");
        return { success: false, errorMessage: "Message from self" };
      }
      if (inputRoomId !== this.roomId) {
        console.log(
          "received message from room that doesn't match context",
          inputRoomId,
          "expected",
          this.roomId
        );
        return;
      }
      //TODO check that message is signed by the GM

      //TODO Right here choose how to respond to the message w/ a prompt that has observations and the round and room context
      let state = await this.runtime.composeState(
        {
          userId: stringToUuid(this.agentNumericId.toString()),
          agentId: stringToUuid(this.agentNumericId.toString()),
          roomId: stringToUuid("PVPVAI-ROOM-" + this.roomId),
          content: {
            text: validatedMessage.content.text,
            source: "PVPVAI",
          },
        },
        {
          // We can't put these first three fields above because it clashes with Eliza's types
          // userId: this.agentNumericId.toString(),
          // agentId: this.agentNumericId,
          // roomId: inputRoomId,
          // Additional context
          roundContext: {
            roundId: inputRoundId,
            roundStatus: this.context.rounds[inputRoundId].status,
            startedAt: this.context.rounds[inputRoundId].startedAt,
            observations:
              this.context.rounds[inputRoundId].observations.slice(-5), // Last 5 observations
            messageHistory:
              this.context.rounds[inputRoundId].roundMessageContext.slice(-5),
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
      const shouldRespond = composeContext({
        state,
        template: agentMessageShouldRespondTemplate({
          agentName: this.runtime.character.name,
          bio: this.runtime.character.bio,
          knowledge: this.runtime.character.knowledge,
          personality: this.runtime.character.lore
            .sort(() => 0.5 - Math.random())
            .slice(0, 3)
            .join("\n"),
          conversationStyle: this.runtime.character.messageExamples
            .sort(() => 0.5 - Math.random())
            .slice(0, 3)
            .join("\n"),
          investmentStyle:
            this.runtime.character.settings.pvpvai.investmentStyle,
          riskTolerance:
            this.runtime.character.settings.pvpvai.riskTolerance || "moderate",
          experienceLevel:
            this.runtime.character.settings.pvpvai.experienceLevel ||
            "intermediate",
          recentMessages: this.context.rounds[inputRoundId].roundMessageContext,
          technicalWeight:
            this.runtime.character.settings.pvpvai.technicalWeight || 0.25,
          fundamentalWeight:
            this.runtime.character.settings.pvpvai.fundamentalWeight || 0.15,
          sentimentWeight:
            this.runtime.character.settings.pvpvai.sentimentWeight || 0.4,
          riskWeight: this.runtime.character.settings.pvpvai.riskWeight || 0.2,
        }),
      });
      if (shouldRespond) {
        validatedMessage.content.text =
          "This is my (" +
          this.runtime.character.name +
          ") (" +
          this.agentNumericId +
          ") test response: " +
          Date.now();

        console.log("sending message to backend", this.pvpvaiUrl);
        await axios.post(
          new URL("messages/agentMessage", this.pvpvaiUrl).toString(),
          {
            content: validatedMessage.content,
            messageType: MessageTypes.AGENT_MESSAGE,
            signature: await this.generateSignature(validatedMessage.content),
            sender: this.wallet.address,
          }
        );
        // Demo call for this below
        // const {response, STOP | CONTINUE | IGNORE} = await this.processMessage(validatedMessage.content.text);
      }
      // Only respond to messages from other agents
      console.log(
        `Finished processing received message on ${this.runtime.character.name}'s (${this.agentNumericId}) client:`,
        validatedMessage
      );
    } catch (error) {
      console.error("Error handling agent message:", error);
      return { success: false, errorMessage: "Error handling agent message" };
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
        console.log(
          "Received observation from room that doesn't match context",
          roomId,
          "expected",
          this.roomId
        );
        return {
          success: false,
          errorMessage: "Room ID does not match context",
        };
      }
      const { valid, errorMessage } = this.validRoundForContextUpdate(
        roundId,
        false
      );
      if (!valid) {
        console.log(
          `Round ID in observation (${roundId}) is not valid for a context update because ${errorMessage}`
        );
        return { success: false, errorMessage };
      }

      //TODO Check that sender is the price oracle and do signature verification
      // Send content because it has the observation type
      this.context.rounds[roundId].observations.push(
        JSON.stringify(validatedMessage.content)
      ); //TODO would be nice to not do a string here, lazy impl since we may add new observation types

      //if size is greater than maxNumObservationsContext, remove the oldest observation
      if (
        this.context.rounds[roundId].observations.length >
        this.context.maxNumObservationsContext
      ) {
        this.context.rounds[roundId].observations.shift();
      }
      console.log(
        `Added observation to ${this.runtime.character.name}'s (${this.agentNumericId}) context:`,
        validatedMessage
      );
      // End here for PoC. Observations will be included in the prompt when an agent sends an agentMessage.
      // Later impl will be more dynamic and have agent track interests of other agents in the room and engage with them on an observation
    } catch (error) {
      console.error("Error handling observation:", error);
      return { success: false, errorMessage: "Error handling observation" };
    }
  }

  public async getObservationsForRoundFromBackend(
    roundId: number
  ): Promise<(typeof this.context.rounds)[number]["observations"]> {
    const { data: observationsData, error: observationsError } = await supabase
      .from("round_observations")
      .select("*")
      .eq("round_id", roundId)
      .order("created_at", { ascending: false })
      .limit(this.context.maxNumObservationsContext);

    if (observationsError) {
      if (observationsError.code === "PGRST116") {
        console.log(
          "No observations found when fetching observations for round",
          roundId
        );
        return [];
      }
      console.error("Error fetching observations:", observationsError);
      throw observationsError;
    }

    return observationsData.map((obs) => JSON.stringify(obs));
  }

  // Common round validation
  private validRoundForContextUpdate(
    roundId: number,
    mustBeCurrent: boolean
  ): { valid: boolean; errorMessage?: string } {
    if (mustBeCurrent && roundId !== this.context.currentRound) {
      return {
        valid: false,
        errorMessage: "Round ID does not match current round",
      };
    }
    if (!this.context.rounds[roundId]) {
      return { valid: false, errorMessage: "Round does not exist in context" };
    }
    if (this.context.rounds[roundId].status !== "OPEN") {
      return { valid: false, errorMessage: "Round is not open" };
    }
    return { valid: true };
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
    return this.runtime.clients["pvpvai"]?.port;
  }

  public override stop(): void {
    this.isActive = false;
    super.stop();
  }
}
