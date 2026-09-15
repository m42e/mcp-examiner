import ReactMarkdown from "react-markdown";

function dedentMarkdown(value: string) {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const contentLines = lines.filter((line) => line.trim().length > 0);
  const commonIndent = contentLines.length === 0
    ? 0
    : Math.min(...contentLines.map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0));

  const removeIndent = (line: string, indent: number) => (
    line.trim().length === 0 ? "" : line.slice(indent)
  );

  if (commonIndent >= 4) {
    return lines.map((line) => removeIndent(line, commonIndent)).join("\n");
  }

  const hasIndentedMarkdownBlock = lines.some((line) => (
    /^ {4}(?:[-+*]\s|\d+[.)]\s|#{1,6}\s|>\s|```)/.test(line)
  ));
  if (!hasIndentedMarkdownBlock) return value;
  return lines.map((line) => line.startsWith("    ") ? removeIndent(line, 4) : line).join("\n");
}

export function MarkdownText({
  value,
  renderMarkdown,
  className,
  plainTag = "div",
}: {
  value: string;
  renderMarkdown: boolean;
  className?: string;
  plainTag?: "div" | "p" | "small";
}) {
  const classes = [
    "markdown-text",
    renderMarkdown ? "markdown-rendered" : "markdown-plain",
    className,
  ].filter(Boolean).join(" ");

  if (renderMarkdown) {
    return (
      <div className={classes}>
        <ReactMarkdown>{dedentMarkdown(value)}</ReactMarkdown>
      </div>
    );
  }

  if (plainTag === "small") return <small className={classes}>{value}</small>;
  if (plainTag === "p") return <p className={classes}>{value}</p>;
  return <div className={classes}>{value}</div>;
}