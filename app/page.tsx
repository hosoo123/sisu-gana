import QuizFrame from "./quiz-frame";

type PageProps = {
  searchParams: Promise<{ mode?: string; code?: string }>;
};

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;
  const mode = params.mode === "host" ? "host" : "play";

  return <QuizFrame mode={mode} code={params.code} />;
}
