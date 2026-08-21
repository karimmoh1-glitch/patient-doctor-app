"use client";

import { useEffect, useRef, useState } from "react";

type SpeechRecognitionResultLike = {
  results: { [index: number]: { [index: number]: { transcript: string } }; length: number };
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionResultLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

export default function VoiceTextarea({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(true);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const baseTextRef = useRef("");

  useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const SpeechRecognitionCtor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time feature detection on mount
      setSupported(false);
      return;
    }
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      const base = baseTextRef.current;
      onChange(base ? `${base} ${transcript}` : transcript);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);

    recognitionRef.current = recognition;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleListening() {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (listening) {
      recognition.stop();
      setListening(false);
    } else {
      baseTextRef.current = value ? value + " " : "";
      recognition.start();
      setListening(true);
    }
  }

  return (
    <div>
      <div className="relative">
        <textarea
          rows={4}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. I've had a sharp headache and dizziness since this morning..."
          className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-4 py-2 pr-14 resize-none"
        />
        {supported && (
          <button
            type="button"
            onClick={toggleListening}
            title={listening ? "Stop recording" : "Speak your symptoms"}
            className={`absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full transition ${
              listening
                ? "bg-red-600 text-white animate-pulse"
                : "bg-neutral-200 dark:bg-neutral-800 hover:bg-blue-600 hover:text-white"
            }`}
          >
            🎤
          </button>
        )}
      </div>
      {listening && <p className="text-xs text-red-600 mt-1">Listening…</p>}
      {!supported && (
        <p className="text-xs text-neutral-500 mt-1">
          Voice input isn&rsquo;t supported in this browser — just type instead.
        </p>
      )}
    </div>
  );
}
