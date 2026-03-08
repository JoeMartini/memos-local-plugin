/**
 * OpenClaw Platform API Client
 *
 * This module provides access to OpenClaw platform's default embedding and completion capabilities.
 * These are used as fallback when no explicit model provider is configured.
 */

import type { Logger, OpenClawAPI } from "./types";

export interface OpenClawEmbedRequest {
  texts: string[];
  model?: string;
}

export interface OpenClawEmbedResponse {
  embeddings: number[][];
  dimensions: number;
}

export interface OpenClawCompleteRequest {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

export interface OpenClawCompleteResponse {
  text: string;
}

/**
 * Placeholder OpenClaw API client.
 *
 * In a real OpenClaw plugin environment, this would be provided by the platform
 * via the plugin context (e.g., ctx.api or ctx.openclaw).
 *
 * Currently throws errors indicating the feature is not yet available.
 * When the platform API is ready, replace the throw statements with actual API calls.
 */
export class OpenClawAPIClient implements OpenClawAPI {
  constructor(private log: Logger) {}

  /**
   * Call OpenClaw platform's default embedding service.
   *
   * @param request - Embedding request with texts to embed
   * @returns Embedding vectors
   * @throws Error if the platform API is not available
   */
  async embed(request: OpenClawEmbedRequest): Promise<OpenClawEmbedResponse> {
    this.log.debug("OpenClawAPI.embed called (not yet implemented)");

    // TODO: Replace with actual OpenClaw platform API call
    // Example implementation when API is available:
    //
    // const response = await fetch(`${this.platformEndpoint}/v1/embed`, {
    //   method: 'POST',
    //   headers: {
    //     'Content-Type': 'application/json',
    //     'Authorization': `Bearer ${this.platformToken}`,
    //   },
    //   body: JSON.stringify(request),
    // });
    //
    // if (!response.ok) {
    //   throw new Error(`OpenClaw embed API failed: ${response.statusText}`);
    // }
    //
    // return await response.json();

    throw new Error(
      "OpenClaw host embedding is not available in this build. " +
      "Please configure an explicit embedding provider (openai, gemini, cohere, etc.) " +
      "or the system will fall back to local Xenova embedding."
    );
  }

  /**
   * Call OpenClaw platform's default LLM completion service.
   *
   * @param request - Completion request with prompt
   * @returns Generated text
   * @throws Error if the platform API is not available
   */
  async complete(request: OpenClawCompleteRequest): Promise<OpenClawCompleteResponse> {
    this.log.debug("OpenClawAPI.complete called (not yet implemented)");

    // TODO: Replace with actual OpenClaw platform API call
    // Example implementation when API is available:
    //
    // const response = await fetch(`${this.platformEndpoint}/v1/complete`, {
    //   method: 'POST',
    //   headers: {
    //     'Content-Type': 'application/json',
    //     'Authorization': `Bearer ${this.platformToken}`,
    //   },
    //   body: JSON.stringify(request),
    // });
    //
    // if (!response.ok) {
    //   throw new Error(`OpenClaw complete API failed: ${response.statusText}`);
    // }
    //
    // return await response.json();

    throw new Error(
      "OpenClaw host completion is not available in this build. " +
      "Please configure an explicit summarizer provider (openai, anthropic, gemini, etc.) " +
      "or the system will fall back to rule-based summarization."
    );
  }
}
