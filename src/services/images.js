const https = require('https');
const http = require('http');
const ai = require('./ai');

class ImageService {
  // Download image and return as base64
  async _downloadImage(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      client.get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download image: HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  // Analyze an image using Ollama's vision capabilities
  async analyze(imageUrl) {
    try {
      const imageBuffer = await this._downloadImage(imageUrl);
      const base64Image = imageBuffer.toString('base64');

      const response = await ai.ollama.chat({
        model: ai.getModel(),
        messages: [
          {
            role: 'user',
            content: 'Describe this image briefly in 1-2 sentences.',
            images: [base64Image],
          },
        ],
      });

      return response.message.content;
    } catch (err) {
      console.error('Image analysis error:', err.message);
      // Fall back to URL-based description attempt
      if (err.message.includes('does not support images')) {
        return `[Image shared - current model (${ai.getModel()}) doesn't support vision. Try a vision model like llava or llama3.2-vision.]`;
      }
      return null;
    }
  }

  // Extract image URLs from a Discord message
  getImageUrls(message) {
    const urls = [];

    // Check attachments
    if (message.attachments?.size > 0) {
      for (const attachment of message.attachments.values()) {
        if (attachment.contentType?.startsWith('image/')) {
          urls.push(attachment.url);
        }
      }
    }

    // Check embeds
    if (message.embeds?.length > 0) {
      for (const embed of message.embeds) {
        if (embed.image?.url) urls.push(embed.image.url);
        if (embed.thumbnail?.url) urls.push(embed.thumbnail.url);
      }
    }

    return urls;
  }
}

module.exports = new ImageService();
