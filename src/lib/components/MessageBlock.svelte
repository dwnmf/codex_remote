<script lang="ts">
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import type { Message } from "../types";
  import { MAX_MARKDOWN_RENDER_CHARS } from "../message-limits";
  import ShimmerDot from "./ShimmerDot.svelte";
  import Reasoning from "./Reasoning.svelte";
  import Tool from "./Tool.svelte";

  interface Props {
    message: Message;
  }

  const { message }: Props = $props();

  const isReasoning = $derived(message.role === "assistant" && message.kind === "reasoning");
  const isTool = $derived(
    message.role === "tool" &&
    message.kind !== "terminal" &&
    message.kind !== "wait" &&
    message.kind !== "compaction"
  );
  const isTerminal = $derived(message.role === "tool" && message.kind === "terminal");
  const isWait = $derived(message.role === "tool" && message.kind === "wait");
  const isCompaction = $derived(message.role === "tool" && message.kind === "compaction");
  const renderPlainText = $derived(message.text.length > MAX_MARKDOWN_RENDER_CHARS);

  const prefixConfig = $derived.by(() => {
    if (message.role === "user") {
      return { prefix: ">", color: "var(--cli-prefix-agent)", bgClass: "user-bg" };
    }
    if (message.role === "assistant") {
      return { prefix: "•", color: "var(--cli-prefix-agent)", bgClass: "" };
    }
    if (message.role === "tool") {
      return { prefix: "•", color: "var(--cli-prefix-tool)", bgClass: "" };
    }
    return { prefix: "•", color: "var(--cli-text-dim)", bgClass: "" };
  });

  const terminalLines = $derived.by(() => {
    if (!isTerminal) return [];
    const lines = message.text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  });

  const renderedMarkdown = $derived.by(() => {
    if (renderPlainText) return "";
    return DOMPurify.sanitize(
      marked.parse(message.text, {
        async: false,
        breaks: true,
      }) as string,
    );
  });
</script>

<div class="message-block {prefixConfig.bgClass}">
  {#if isReasoning}
    <Reasoning
      content={message.text}
      defaultOpen={false}
    />
  {:else if isTool}
    <Tool {message} />
  {:else if isWait}
    <div class="message-line wait row">
      <span class="prefix" style:color={prefixConfig.color}>{prefixConfig.prefix}</span>
      <div class="wait-line row">
        <ShimmerDot color="var(--cli-prefix-tool)" />
        <span class="text dim">{message.text}</span>
      </div>
    </div>
  {:else if isCompaction}
    <div class="message-line compaction row">
      <span class="compaction-icon">↕</span>
      <span class="text dim">Context compacted</span>
    </div>
  {:else if isTerminal}
    <div class="message-line terminal row">
      <span class="prefix" style:color={prefixConfig.color}>{prefixConfig.prefix}</span>
      <div class="terminal-lines stack">
        {#each terminalLines as line}
          <div class="terminal-line row">
            <span class="text">{line}</span>
          </div>
        {/each}
      </div>
    </div>
  {:else}
    <div class="message-line row">
      <span class="prefix" style:color={prefixConfig.color}>{prefixConfig.prefix}</span>
      {#if renderPlainText}
        <div class="text">{message.text}</div>
      {:else}
        <div class="text md-text">{@html renderedMarkdown}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .message-block {
    padding: var(--space-xs) var(--space-md);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: 1.6;
  }

  .message-block.user-bg {
    background: var(--cli-bg-user);
    border-left: 0;
    box-shadow: none;
    padding-left: var(--space-md);
  }


  .message-line {
    --row-gap: var(--space-sm);
    align-items: flex-start;
  }

  .message-line.terminal {
    align-items: flex-start;
  }

  .message-line.wait {
    align-items: center;
  }

  .terminal-lines {
    --stack-gap: 0.1rem;
  }

  .terminal-line {
    --row-gap: var(--space-sm);
  }

  .wait-line {
    --row-gap: var(--space-sm);
  }

  .message-line.compaction {
    --row-gap: var(--space-sm);
    justify-content: center;
  }

  .compaction-icon {
    color: var(--cli-text-muted);
    font-size: var(--text-xs);
  }

  .prefix {
    flex-shrink: 0;
    font-weight: 600;
  }

  .text {
    color: var(--cli-text);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .md-text {
    white-space: normal;
  }

  .md-text :global(p),
  .md-text :global(ul),
  .md-text :global(ol),
  .md-text :global(blockquote) {
    margin: 0.22rem 0;
  }

  .md-text :global(:first-child) {
    margin-top: 0;
  }

  .md-text :global(:last-child) {
    margin-bottom: 0;
  }

  .md-text :global(ul),
  .md-text :global(ol) {
    padding-left: 1.25rem;
  }

  .md-text :global(code) {
    font-family: var(--font-mono);
    font-size: 0.9em;
    padding: 0.05em 0.28em;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--cli-bg-elevated) 80%, transparent);
  }

  .md-text :global(pre) {
    margin: 0.35rem 0;
    padding: 0.35rem 0.45rem;
    border: 1px solid color-mix(in srgb, var(--cli-border) 60%, transparent);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--cli-bg-elevated) 85%, transparent);
    overflow-x: auto;
  }

  .md-text :global(pre code) {
    background: transparent;
    padding: 0;
  }

  .text.dim {
    color: var(--cli-text-dim);
    font-style: italic;
  }
</style>
