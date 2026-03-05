import Head from "next/head";
import SummarizerAgent from "../components/SummarizerAgent";

export default function Home() {
  return (
    <>
      <Head>
        <title>Multilingual Summarization Agent</title>
        <meta name="description" content="AI-powered article summarizer — English, French, Spanish, Chinese" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <SummarizerAgent />
    </>
  );
}
