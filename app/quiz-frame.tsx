type QuizFrameProps = {
  mode: "host" | "play";
  code?: string;
};

export default function QuizFrame({ mode, code }: QuizFrameProps) {
  const params = new URLSearchParams({ mode });
  if (code) params.set("code", code);

  return (
    <iframe
      className="quiz-frame"
      src={`/index.html?${params}`}
      title="SISU Live Quiz"
    />
  );
}
