const latestTextArray = this.textArray.join(', ');

        this.discord.sendMessage(channelId, `*${latestTextArray}*`);

      // Apply filter to new messages before saving to history
      this.latestMessage.content = this.latestMessage.content
        .replace(re.escape(respondBot), '')
        .trim();

      // Log the processed content to console immediately
      console.log('[Responder] Message received and processed:', this.latestMessage.content);

      this.storeMessageInMemory(this.latestMessage);
      this.commandHandler(this.latestMessage);

      // Update the latestMessage property with the transaction, user ID, direct flag, and content
      this.latestMessage = {
        content: this.latestMessage.content,
        user: this.latestMessage.user,
        direct: this.latestMessage.direct,
        timestamp: Date.now(),
      };