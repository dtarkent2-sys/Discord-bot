const cleanedPrompt = input.trim().replace(/\s+/g, ' ');
const isCommand = cleanedPrompt.toLowerCase().startsWith('!');
const commandBody = cleanedPrompt.slice(1).trim();