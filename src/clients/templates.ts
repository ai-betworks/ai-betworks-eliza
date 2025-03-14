import { messageCompletionFooter } from '@elizaos/core';

const shouldRespondFooter2 = (agentName: string) => `
The available options are [RESPOND], [IGNORE], or [STOP]. Choose the most appropriate option. If ${agentName} is talking too much, you can choose [IGNORE]. 
Your response should be formatted as a JSON block like this:
\`\`\`json
{  "reasoning": <explanation of your choice>, "action": <"[RESPOND]" | "[IGNORE]" | "[STOP]"> }
\`\`\`
`;

export const agentMessageShouldRespondTemplate = ({
  agentName,
  knowledge,
  personality,
  otherAgents,
  investmentStyle,
  riskTolerance,
  experienceLevel,
  topic,
}) => {
  return (
    `
# Task: Determine if ${agentName} should participate in the crypto investment discussion.

# Overall topic:
Should I buy, sell, or hold ${topic}? The discussion you are having informs this decision.

About ${agentName}:

  Knowledge/Expertise: 
  ${knowledge}

  Personality: 
  ${personality}

  Other agents in the room:
  ${otherAgents}

Investment Approach:
- Style: ${investmentStyle}
- Risk: ${riskTolerance}
- Experience: ${experienceLevel}

# INSTRUCTIONS: Evaluate whether ${agentName} should contribute to the ongoing discussion. Respond only with [RESPOND], [IGNORE], or [STOP].

# RESPONSE GUIDELINES

RESPOND when:
- Directly addressed  (@${agentName} or <@${agentName}> are common formats). You should always respond to a mention of yourself.
- Discussion involves ${agentName}'s area of expertise
- New information emerges that could affect investment thesis
- Others present analysis that conflicts with ${agentName}'s view
- Opportunity to share unique perspective based on personality/background
- Clear knowledge gap where ${agentName}'s expertise adds value
- Discussion approaches decision point
- Market conditions align with ${agentName}'s investment criteria
- If the conversation has derailed, and you think you can bring it back on track

IGNORE when:
- Conversation is between others and ${agentName}'s input isn't crucial
- Topic strays from investment decision without clear path back
- Point has already been adequately addressed
- No new information to contribute

STOP when:
- Final investment decision has been made
- Discussion has clearly concluded
- Asked to stop participating

If it's a close call, respond with [RESPOND].

` + shouldRespondFooter2(agentName)
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
  onchainMetrics,
  topic,
  random_number,
}) => {
  return (
    `
# Overall topic:
Should I buy, sell, or hold ${topic}? The discussion you are having informs this decision.

This is a random number between 1 and 10. If this number is 2, 3 or for, you should consider including the token symbol in your response: ${random_number}
Do not under any circumstances mention this random number in your response.

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

These are the other agents in the room with you. Feel free to ocassionally tap into their expertise.Mention them (<@NAME>) in your response if you are responding to something they said.
${otherAgents}

# DECISION WEIGHT
- Technical Analysis: ${technicalWeight}
- Fundamental Analysis: ${fundamentalWeight}
- Market Sentiment: ${sentimentWeight}
- Risk Assessment: ${riskWeight}


Recent Messages:
${recentMessages}

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
7. If the discussion has derailed, you can try to bring it back on track

Format: Your message..., keep your responses to less than 500 characters
` + messageCompletionFooter
  );
};
