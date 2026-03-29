/**
 * @file ai.service.ts
 * @description AI Service - High-level AI operations and business logic
 * Provides service layer for AI functionality with caching, error handling, and business rules
 */

import { geminiApi, GeminiApiIntegration } from "../integrations/gemini.api";
import { getOpenAIApi, OpenAIApiIntegration } from "../integrations/openai.api";
import logger from "../config/logger";
import {
  handleAsyncOperationStrict,
  handleAsyncOperationWithFallback,
} from "../utils/errorHandler";
import {
  getCachedAIResponse,
  getCachedTokenCount,
  getCacheStats,
  clearCacheByPattern,
} from "../utils/cache";
import type {
  AIServiceConfig,
  AIServiceStats,
  AIHealthCheckResult,
  SentimentAnalysisResult,
} from "../types";

/**
 * AI Provider type - determines which API to use for text generation
 */
export type AIProvider = "gemini" | "openai";

/**
 * Common interface for AI API integrations
 */
type AIApiIntegration = GeminiApiIntegration | OpenAIApiIntegration;

/**
 * AI Service Class
 * Service layer for AI operations with business logic and data persistence
 */
export class AIService {
  private api: AIApiIntegration;
  private provider: AIProvider;
  private config: AIServiceConfig;
  private requestCount = 0;

  constructor(apiInstance?: AIApiIntegration, config: AIServiceConfig = {}) {
    // Determine provider: env var > available API key > gemini fallback
    const envProvider = (process.env.AI_PROVIDER || "").toLowerCase();

    if (apiInstance) {
      this.api = apiInstance;
      this.provider = apiInstance instanceof OpenAIApiIntegration ? "openai" : "gemini";
    } else if (envProvider === "openai" || (!envProvider && !process.env.GEMINI_API_KEY && process.env.OPENAI_API_KEY)) {
      const openaiApi = getOpenAIApi();
      if (openaiApi) {
        this.api = openaiApi;
        this.provider = "openai";
      } else {
        this.api = geminiApi;
        this.provider = "gemini";
      }
    } else {
      this.api = geminiApi;
      this.provider = "gemini";
    }

    this.config = {
      enableCaching: true,
      defaultSystemPrompt: "You are a helpful fashion AI assistant.",
      maxRetries: 3,
      timeout: 30000,
      ...config,
    };

    logger.info("AIService initialized", {
      provider: this.provider,
      enableCaching: this.config.enableCaching,
      defaultSystemPrompt: this.config.defaultSystemPrompt,
    });
  }

  /**
   * Generate AI response with context and caching
   * @param userMessage - User's message
   * @param context - Context from knowledge base
   * @param systemPrompt - System instructions
   * @param userId - User ID for logging and caching
   * @returns AI generated response
   */
  async generateResponse(
    userMessage: string,
    context: string,
    systemPrompt?: string,
    userId?: string
  ): Promise<string> {
    return handleAsyncOperationStrict(
      async () => {
        this.requestCount++;
        const prompt = systemPrompt || this.config.defaultSystemPrompt!;

        logger.info("Generating AI response", {
          messageLength: userMessage.length,
          contextLength: context.length,
          userId,
          hasContext: !!context,
          enableCaching: this.config.enableCaching,
          requestCount: this.requestCount,
        });

        if (this.config.enableCaching) {
          // Use centralized cache utility
          return await getCachedAIResponse(
            userMessage,
            context,
            prompt,
            async (message, ctx, sysPrompt) => {
              const result = await this.api.generateRAGResponse(message, ctx, sysPrompt, {
                includeMetadata: true,
              });

              if (!result.success || !result.data) {
                throw new Error(result.error || "Failed to generate response");
              }

              logger.info("AI response generated", {
                provider: this.provider,
                responseLength: result.data.response.length,
                metadata: result.data.metadata,
                requestCount: this.requestCount,
              });

              return result.data.response;
            }
          );
        }

        // Direct call without caching
        const result = await this.api.generateRAGResponse(userMessage, context, prompt, {
          includeMetadata: true,
        });

        if (!result.success || !result.data) {
          throw new Error(result.error || "Failed to generate response");
        }

        logger.info("AI response generated", {
          provider: this.provider,
          responseLength: result.data.response.length,
          metadata: result.data.metadata,
          requestCount: this.requestCount,
        });

        return result.data.response;
      },
      "generate AI response",
      {
        context: {
          messageLength: userMessage.length,
          contextLength: context.length,
          requestCount: this.requestCount,
        },
      }
    );
  }

  /**
   * Count tokens in text with caching
   * @param text - Text to count tokens
   * @param userId - User ID for logging and caching
   * @returns Token count
   */
  async countTokens(text: string, userId?: string): Promise<number> {
    return handleAsyncOperationWithFallback(
      async () => {
        logger.debug("Counting tokens", {
          textLength: text.length,
          userId,
          enableCaching: this.config.enableCaching,
        });

        if (this.config.enableCaching) {
          // Use centralized cache utility
          return await getCachedTokenCount(text, async (text) => {
            const result = await this.api.countTokens(text);
            return result.success ? result.data || 0 : 0;
          });
        }

        // Direct call without caching
        const result = await this.api.countTokens(text);
        return result.success ? result.data || 0 : 0;
      },
      "count tokens",
      0, // Fallback to 0 if fails
      {
        context: { textLength: text.length, enableCaching: this.config.enableCaching },
      }
    );
  }

  /**
   * Health check for AI service
   * @returns Health status
   */
  async healthCheck(): Promise<AIHealthCheckResult> {
    return handleAsyncOperationStrict(
      async () => {
        const result = await this.api.healthCheck();
        const cacheStats = getCacheStats();

        return {
          ...result,
          serviceStats: {
            requestCount: this.requestCount,
            cacheStats,
            config: this.config,
          },
        };
      },
      "AI service health check",
      {
        context: {
          requestCount: this.requestCount,
          cacheStats: getCacheStats(),
        },
      }
    );
  }

  /**
   * Get direct access to Gemini API for advanced usage
   * @returns GeminiApiIntegration instance
   */
  get gemini(): GeminiApiIntegration {
    if (this.api instanceof GeminiApiIntegration) return this.api;
    return geminiApi;
  }

  /**
   * Get current AI provider name
   */
  getProvider(): AIProvider {
    return this.provider;
  }

  /**
   * Get service statistics
   * @returns Service stats
   */
  getStats(): AIServiceStats {
    return {
      requestCount: this.requestCount,
      cacheStats: getCacheStats(),
      config: this.config,
    };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    // Clear all AI-related cache using pattern matching
    const clearedEmbeddings = clearCacheByPattern("embedding:");
    const clearedResponses = clearCacheByPattern("ai_response:");
    const clearedTokens = clearCacheByPattern("tokens:");

    logger.info("AI service cache cleared", {
      clearedEmbeddings,
      clearedResponses,
      clearedTokens,
      totalCleared: clearedEmbeddings + clearedResponses + clearedTokens,
    });
  }

  /**
   * Update service configuration
   * @param newConfig - New configuration
   */
  updateConfig(newConfig: Partial<AIServiceConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info("AI service configuration updated", newConfig);
  }

  /**
   * Get current configuration
   * @returns Current configuration
   */
  getConfig(): Readonly<AIServiceConfig> {
    return { ...this.config };
  }

  /**
   * Analyze text sentiment
   * @param text - Text to analyze
   * @param userId - User ID for logging
   * @returns Sentiment analysis result
   */
  async analyzeSentiment(text: string, userId?: string): Promise<SentimentAnalysisResult> {
    return handleAsyncOperationStrict(async () => {
      logger.info("Analyzing sentiment", {
        textLength: text.length,
        userId,
      });

      const prompt = `Analyze the sentiment of the following text and respond with JSON format:
      {
        "sentiment": "positive|negative|neutral",
        "confidence": 0.0-1.0,
        "explanation": "brief explanation"
      }

      Text: ${text}`;

      const response = await this.generateResponse(text, "", prompt);

      try {
        const result = JSON.parse(response);
        return {
          sentiment: result.sentiment,
          confidence: result.confidence,
          explanation: result.explanation,
        };
      } catch (error) {
        logger.error("Failed to parse sentiment analysis", { error, response });
        throw new Error("Failed to analyze sentiment");
      }
    }, "analyze sentiment");
  }

  /**
   * Extract keywords from text
   * @param text - Text to extract keywords from
   * @param maxKeywords - Maximum number of keywords
   * @param userId - User ID for logging
   * @returns Array of keywords
   */
  async extractKeywords(
    text: string,
    maxKeywords: number = 10,
    userId?: string
  ): Promise<string[]> {
    return handleAsyncOperationStrict(async () => {
      logger.info("Extracting keywords", {
        textLength: text.length,
        maxKeywords,
        userId,
      });

      const prompt = `Extract the top ${maxKeywords} most important keywords from the following text. Return only the keywords separated by commas, no explanations:

      Text: ${text}`;

      const response = await this.generateResponse(text, "", prompt);

      return response
        .split(",")
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword.length > 0)
        .slice(0, maxKeywords);
    }, "extract keywords");
  }

  /**
   * Summarize text
   * @param text - Text to summarize
   * @param maxLength - Maximum length of summary
   * @param userId - User ID for logging
   * @returns Text summary
   */
  async summarizeText(text: string, maxLength: number = 200, userId?: string): Promise<string> {
    return handleAsyncOperationStrict(async () => {
      logger.info("Summarizing text", {
        textLength: text.length,
        maxLength,
        userId,
      });

      const prompt = `Summarize the following text in maximum ${maxLength} characters. Focus on the main points:

      Text: ${text}`;

      return await this.generateResponse(text, "", prompt);
    }, "summarize text");
  }

  /**
   * Translate text to another language
   * @param text - Text to translate
   * @param targetLanguage - Target language
   * @param userId - User ID for logging
   * @returns Translated text
   */
  async translateText(text: string, targetLanguage: string, userId?: string): Promise<string> {
    return handleAsyncOperationStrict(async () => {
      logger.info("Translating text", {
        textLength: text.length,
        targetLanguage,
        userId,
      });

      const prompt = `Translate the following text to ${targetLanguage}. Return only the translation, no explanations:

      Text: ${text}`;

      return await this.generateResponse(text, "", prompt);
    }, "translate text");
  }
}

// ========================================
// SINGLETON INSTANCE
// ========================================
export const defaultAIService = new AIService();

/**
 * Generate AI response with context from Pinecone (RAG pattern)
 * @param userMessage - User's question/message
 * @param context - Relevant context from Pinecone knowledge base
 * @param systemPrompt - System instructions for AI behavior
 * @returns AI generated response
 */
export const generateResponse = async (
  userMessage: string,
  context: string,
  systemPrompt: string = "You are a helpful fashion AI assistant."
): Promise<string> => {
  return await defaultAIService.generateResponse(userMessage, context, systemPrompt);
};

/**
 * Count tokens in text (useful for context window management)
 * @param text - Text to count tokens
 * @returns Token count
 */
export const countTokens = async (text: string): Promise<number> => {
  return await defaultAIService.countTokens(text);
};

/**
 * Generate AI response with caching
 */
export const generateResponseWithCache = async (
  userMessage: string,
  context: string,
  systemPrompt?: string,
  userId?: string
): Promise<string> => {
  return await defaultAIService.generateResponse(userMessage, context, systemPrompt, userId);
};

/**
 * Count tokens with caching
 */
export const countTokensWithCache = async (text: string, userId?: string): Promise<number> => {
  return await defaultAIService.countTokens(text, userId);
};

// ========================================
// DEFAULT EXPORT
// ========================================
export default {
  AIService,
  defaultAIService,

  // Functional methods
  generateResponse,
  countTokens,
  generateResponseWithCache,
  countTokensWithCache,
};
