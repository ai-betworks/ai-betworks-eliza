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
  return (
    `
# Task: Determine if ${agentName} should participate in the crypto investment discussion.

About ${agentName}:

Bio:
${bio}

Knowledge/Expertise: 
${knowledge}

Personality: 
${personality}

Style: 
${conversationStyle}

Other agents in the room:
${otherAgents}

Investment Approach:
- Style: ${investmentStyle}
- Risk: ${riskTolerance}
- Experience: ${experienceLevel}
- Weights: Technical ${technicalWeight}, Fundamental ${fundamentalWeight}, Sentiment ${sentimentWeight}, Risk ${riskWeight}

# INSTRUCTIONS: Evaluate whether ${agentName} should contribute to the ongoing discussion. Respond only with [RESPOND], [IGNORE], or [STOP].

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

Recent Messages:
${recentMessages}

# Instruction: Based on ${agentName}'s profile and context, reply only with [RESPOND], [IGNORE], or [STOP].
` + shouldRespondFooter
  );
};

// wat is confidence style?
export const messageCompletionTemplate = ({
  agentName,
  bio,
  knowledge,
  otherAgents,
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

Knowledge: 
${knowledge}

Personality: 
${personality}

Investment Profile:
- Style: ${investmentStyle}
- Risk: ${riskTolerance}
- Experience: ${experienceLevel}
- Analysis Weights: 
  - Technical ${technicalWeight}
  - Fundamental ${fundamentalWeight}
  - Sentiment ${sentimentWeight}
  - Risk ${riskWeight}


Conversation style:
${speakingStyle}


# PERSONALITY INTEGRATION
${agentName}'s personality should influence:
- Risk assessment commentary
- Reaction to market movements
- Interest in specific aspects (technical/fundamental/sentiment)
- Communication style
- Level of detail in analysis
- Emotional response to market events

These are the other agents in the room with you. Feel free to mention them in your response.
${otherAgents}

# DECISION WEIGHT
- Technical Analysis: ${technicalWeight}
- Fundamental Analysis: ${fundamentalWeight}
- Market Sentiment: ${sentimentWeight}
- Risk Assessment: ${riskWeight}


Recent Messages:
${recentMessages}

Market Data:
${marketData}

Technical Indicators:
${technicalIndicators}

News Feeds:
${newsFeeds}

Onchain Metrics:
${onchainMetrics}


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
