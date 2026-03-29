/**
 * @file openai.api.ts
 * @description OpenAI API integration layer
 * Mirrors the Gemini API integration interface for seamless provider switching
 */

import OpenAI from "openai";
import logger from "../config/logger";
import type {
  ApiResponse,
  RAGOptions,
  RAGResponseData,
  HealthCheckData,
  GenerationOptions,
} from "../types/gemini";
import type { TenantContext } from "../types/tenant";

/**
 * OpenAI configuration
 */
export interface OpenAIConfig {
  apiKey: string;
  defaultModel: string;
  maxRetries: number;
  retryDelay: number;
  timeout: number;
  models: {
    textGeneration: string;
    textGenerationPro: string;
    fallback: string;
  };
}

/**
 * OpenAI API integration class
 * Implements the same interface as GeminiApiIntegration for provider switching
 */
export class OpenAIApiIntegration {
  private client: OpenAI;
  private config: OpenAIConfig;

  constructor(config: Partial<OpenAIConfig> = {}) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is required");
    }

    this.config = {
      apiKey,
      defaultModel: "gpt-4o-mini",
      maxRetries: 3,
      retryDelay: 2000,
      timeout: 30000,
      models: {
        textGeneration: "gpt-4o-mini",
        textGenerationPro: "gpt-4o",
        fallback: "gpt-4o-mini",
      },
      ...config,
    };

    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
    });

    logger.info("OpenAI API integration initialized", {
      defaultModel: this.config.defaultModel,
    });
  }

  /**
   * Execute API call with retry logic and error handling
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    tenantContext?: TenantContext
  ): Promise<ApiResponse<T>> {
    const startTime = Date.now();
    let lastError: Error | null = null;
    let retries = 0;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        logger.debug(`Executing ${operationName}`, {
          attempt: attempt + 1,
          tenantId: tenantContext?.id,
        });

        const result = await operation();
        const duration = Date.now() - startTime;

        logger.info(`${operationName} completed successfully`, {
          duration,
          retries: attempt,
          tenantId: tenantContext?.id,
        });

        return {
          success: true,
          data: result,
          retries: attempt,
          duration,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        retries = attempt;

        logger.warn(`${operationName} failed`, {
          attempt: attempt + 1,
          error: lastError.message,
          willRetry: attempt < this.config.maxRetries,
          tenantId: tenantContext?.id,
        });

        if (this.isNonRetryableError(lastError)) {
          break;
        }

        if (attempt < this.config.maxRetries) {
          const delay = this.config.retryDelay * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    const duration = Date.now() - startTime;

    logger.error(`${operationName} failed after ${retries + 1} attempts`, {
      duration,
      retries,
      error: lastError?.message,
      tenantId: tenantContext?.id,
    });

    return {
      success: false,
      error: lastError?.message || "Unknown error",
      retries,
      duration,
    };
  }

  private isNonRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes("api key") ||
      message.includes("invalid") ||
      message.includes("permission") ||
      message.includes("authentication")
    );
  }

  private selectModel(useCase: "rag" | "simple" | "complex" | "attributed" = "rag"): string {
    switch (useCase) {
      case "complex":
        return this.config.models.textGenerationPro;
      case "simple":
        return this.config.models.fallback;
      default:
        return this.config.models.textGeneration;
    }
  }

  /**
   * Generate text content
   */
  async generateContent(
    prompt: string,
    options: GenerationOptions = {},
    tenantContext?: TenantContext
  ): Promise<ApiResponse<string>> {
    return this.executeWithRetry(
      async () => {
        const model = options.model || this.selectModel(options.useCase);

        const completion = await this.client.chat.completions.create({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: options.temperature || 0.7,
          max_tokens: options.maxOutputTokens || 8192,
          top_p: options.topP || 0.95,
        });

        const text = completion.choices[0]?.message?.content;

        if (!text || text.trim().length === 0) {
          throw new Error("Empty response from OpenAI API");
        }

        return text;
      },
      "generateContent",
      tenantContext
    );
  }

  /**
   * Count tokens in text (approximate)
   */
  async countTokens(text: string, tenantContext?: TenantContext): Promise<ApiResponse<number>> {
    return this.executeWithRetry(
      async () => {
        // Approximate token count: ~4 chars per token for English
        return Math.ceil(text.length / 4);
      },
      "countTokens",
      tenantContext
    );
  }

  /**
   * Generate structured response for RAG pattern
   */
  async generateRAGResponse(
    userMessage: string,
    context: string,
    systemPrompt: string = "You are a helpful AI assistant.",
    options: RAGOptions = {},
    tenantContext?: TenantContext
  ): Promise<ApiResponse<RAGResponseData>> {
    return this.executeWithRetry(
      async () => {
        const model = this.selectModel("rag");

        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
          { role: "system", content: systemPrompt },
        ];

        if (context) {
          messages.push({
            role: "system",
            content: `Context from knowledge base:\n${context}`,
          });
        }

        messages.push({ role: "user", content: userMessage });

        const completion = await this.client.chat.completions.create({
          model,
          messages,
          temperature: options.temperature || 0.7,
          max_tokens: 8192,
        });

        const responseText = completion.choices[0]?.message?.content;

        if (!responseText || responseText.trim().length === 0) {
          throw new Error("Empty response from OpenAI API");
        }

        const responseData: RAGResponseData = {
          response: responseText,
        };

        if (options.includeMetadata) {
          responseData.metadata = {
            contextLength: context.length,
            promptTokens: completion.usage?.prompt_tokens || 0,
            responseTokens: completion.usage?.completion_tokens || 0,
          };
        }

        return responseData;
      },
      "generateRAGResponse",
      tenantContext
    );
  }

  /**
   * Health check for OpenAI API
   */
  async healthCheck(tenantContext?: TenantContext): Promise<ApiResponse<HealthCheckData>> {
    return this.executeWithRetry(
      async () => {
        const result = await this.generateContent("Hello", { useCase: "simple" }, tenantContext);

        if (!result.success) {
          throw new Error(result.error || "Health check failed");
        }

        return {
          status: "healthy",
          model: this.config.defaultModel,
          timestamp: new Date().toISOString(),
        };
      },
      "healthCheck",
      tenantContext
    );
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<OpenAIConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info("OpenAI API configuration updated", newConfig);
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<OpenAIConfig> {
    return { ...this.config };
  }
}

/**
 * Create OpenAI API integration instance (lazy - only when OPENAI_API_KEY exists)
 */
let openaiApiInstance: OpenAIApiIntegration | null = null;

export const getOpenAIApi = (): OpenAIApiIntegration | null => {
  if (openaiApiInstance) return openaiApiInstance;
  if (!process.env.OPENAI_API_KEY) return null;

  openaiApiInstance = new OpenAIApiIntegration();
  return openaiApiInstance;
};

export const createOpenAIApi = (config: Partial<OpenAIConfig>): OpenAIApiIntegration => {
  return new OpenAIApiIntegration(config);
};

export default getOpenAIApi;
