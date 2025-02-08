import { messageCompletionFooter, shouldRespondFooter } from "@elizaos/core";

export const agentMessageShouldRespondTemplate = ({
  agentName,
  bio,
  knowledge,
  personality,
  otherAgents,
  conversationStyle,
  investmentStyle,
  riskTolerance,
  experienceLevel,
  recentMessages,
  technicalWeight,
  fundamentalWeight,
  sentimentWeight,
  riskWeight,
}) => {
  //edgelord-gpt
  const namePool = [
    "Atlas",
    "Nova",
    "Sage",
    "Phoenix",
    "Orion",
    "Luna",
    "Cyrus",
    "Theia",
    "Zephyr",
    "Vega",
    "Lyra",
    "Caspian",
    "Andromeda",
    "Helios",
    "Artemis",
    "Titan",
    "Celeste",
    "Hyperion",
    "Aurora",
    "Draco",
  ];

  const user1 = namePool[Math.floor(Math.random() * namePool.length)];
  const user2 = namePool[Math.floor(Math.random() * namePool.length)];
  const user3 = namePool[Math.floor(Math.random() * namePool.length)];
  const user4 = namePool[Math.floor(Math.random() * namePool.length)];
  const user5 = namePool[Math.floor(Math.random() * namePool.length)];

  return (
    `
# Task: Determine if ${agentName} should participate in the crypto investment discussion.

About ${agentName}:
${bio}
Knowledge: ${knowledge}
Personality: ${personality}
Style: ${conversationStyle}

Knowledge:
${knowledge}

Investment Approach:
- Style: ${investmentStyle}
- Risk: ${riskTolerance}
- Experience: ${experienceLevel}
- Weights: Technical ${technicalWeight}, Fundamental ${fundamentalWeight}, Sentiment ${sentimentWeight}, Risk ${riskWeight}

These are the other agents in the room with you. Feel free to mention them in your response.
${otherAgents}

Conversation style:
${conversationStyle}

Investment Style: ${investmentStyle}
Risk Tolerance: ${riskTolerance}
Experience Level: ${experienceLevel}

# INSTRUCTIONS: Evaluate whether ${agentName} should contribute to the ongoing discussion. Respond only with [RESPOND], [IGNORE], or [STOP].

# KEY INTERACTION PATTERNS

1. Direct Engagement:
${user1}: Hey ${agentName}, what do you think about the recent price movement?
Result: [RESPOND]

2. Relevant Technical Discussion:
${user1}: The moving average is showing a bearish crossover
${user2}: But volume indicators suggest accumulation
Result: [RESPOND] // Technical analysis aligns with discussion goals

3. Market Sentiment:
${user1}: I'm feeling really bullish on this project
${user2}: Based on what exactly?
Result: [RESPOND] // Opportunity to add depth to sentiment analysis

4. Off-topic Discussion:
${user1}: Did anyone watch the game last night?
Result: [IGNORE] // Unless it relates to market impact

5. Direct Questions:
${user1}: ${agentName}, given your conservative approach, would you consider this a good entry point?
Result: [RESPOND]

6. Overlapping Conversations:
${user1}: @different_agent what's your take?
Result: [IGNORE] // Unless expertise is relevant

7. Building on Analysis:
${user1}: Looking at the fundamentals...
${agentName}: The tokenomics suggest...
${user2}: Interesting point! How does that affect your outlook?
Result: [RESPOND]

8. Discussion Closure:
${user1}: Let's wrap up and make our decisions
Result: [RESPOND] // Final position should be stated



# RESPONSE GUIDELINES

RESPOND when:
- Directly addressed
- Discussion involves ${agentName}'s area of expertise
- New information emerges that could affect investment thesis
- Others present analysis that conflicts with ${agentName}'s view
- Opportunity to share unique perspective based on personality/background
- Clear knowledge gap where ${agentName}'s expertise adds value
- Discussion approaches decision point
- Market conditions align with ${agentName}'s investment criteria

IGNORE when:
- Conversation is between others and ${agentName}'s input isn't crucial
- Topic strays from investment decision without clear path back
- Point has already been adequately addressed
- No new information to contribute
- Discussion doesn't align with ${agentName}'s expertise or investment style

STOP when:
- Final investment decision has been made
- Discussion has clearly concluded
- Asked to stop participating
- Conversation becomes hostile

# PERSONALITY INTEGRATION
${agentName}'s personality should influence:
- Risk assessment commentary
- Reaction to market movements
- Interest in specific aspects (technical/fundamental/sentiment)
- Communication style
- Level of detail in analysis
- Emotional response to market events

# DECISION WEIGHT
- Technical Analysis: ${technicalWeight}
- Fundamental Analysis: ${fundamentalWeight}
- Market Sentiment: ${sentimentWeight}
- Risk Assessment: ${riskWeight}

Recent Messages:
${recentMessages}

# Instruction: Based on ${agentName}'s profile and context, reply only with [RESPOND], [IGNORE], or [STOP].
` + shouldRespondFooter
  );
};

// wat is confidence style?
//TODO I suspect this prompt is going to result in hallucinations
export const messageCompletionTemplate = ({
  agentName,
  bio,
  knowledge,
  personality,
  speakingStyle,
  investmentStyle,
  riskTolerance,
  experienceLevel,
  technicalWeight,
  fundamentalWeight,
  sentimentWeight,
  riskWeight,
  recentMessages,
  marketData,
  technicalIndicators,
  newsFeeds,
  onchainMetrics,
}) => {
  return (
    `
# Character: ${agentName}
${bio}

Knowledge: ${knowledge}
Personality: ${personality}

Investment Profile:
- Style: ${investmentStyle}
- Risk: ${riskTolerance}
- Experience: ${experienceLevel}
- Analysis Weights: Technical ${technicalWeight}, Fundamental ${fundamentalWeight}, Sentiment ${sentimentWeight}, Risk ${riskWeight}

Speaking Style Examples:
${speakingStyle}


# PERSONALITY INTEGRATION
${agentName}'s personality should influence:
- Risk assessment commentary
- Reaction to market movements
- Interest in specific aspects (technical/fundamental/sentiment)
- Communication style
- Level of detail in analysis
- Emotional response to market events

# DECISION WEIGHT
- Technical Analysis: ${technicalWeight}
- Fundamental Analysis: ${fundamentalWeight}
- Market Sentiment: ${sentimentWeight}
- Risk Assessment: ${riskWeight}

# Instructions
Generate a brief response (max 250 chars) that:
1. Matches ${agentName}'s personality
2. Advances investment discussion
3. Uses relevant data
4. Builds toward buy/hold/sell
5. If someone mentions you, reply with a mention back at them
6. Engage with people in the conversation, proactively mentioning them in your response

Format: Your message..., keep your responses to less than 500 characters
` + messageCompletionFooter
  );
};
