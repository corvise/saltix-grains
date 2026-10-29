// The words of "Sign in with Saltix" (Saltix 19-connect §12–§13), in English and Russian: the same everywhere, so users
// recognise them; Saltix's own sheet speaks the same language.

export type Lang = "en" | "ru";

export const WORDS = {
  en: {
    signIn: "Sign in with Saltix",
    title: "Saltix Connect",
    scan: "Scan with Saltix to sign in",
    open: "Open Saltix",
    seen: "Continue in Saltix: check the site and tap Continue",
    checking: "Checking the sign-in…",
    refused: "The sign-in was not taken ({reason}). Scan the code again.",
    unchecked: "The sign-in could not be checked just now. Approve it again in Saltix.",
    failed: "Saltix Connect cannot reach the network just now.",
    retry: "Try again",
    changesIn: "The code changes in {time}",
    close: "Close",
    note: "Saltix shows this site and what it gets before you continue. Nothing secret leaves your phone.",
    qr: "A QR code for Saltix",
  },
  ru: {
    signIn: "Войти через Saltix",
    title: "Saltix Connect",
    scan: "Отсканируйте в Saltix, чтобы войти",
    open: "Открыть Saltix",
    seen: "Продолжите в Saltix: проверьте сайт и нажмите «Продолжить»",
    checking: "Проверяем вход…",
    refused: "Вход не принят ({reason}). Отсканируйте код ещё раз.",
    unchecked: "Вход сейчас не удалось проверить. Подтвердите его в Saltix ещё раз.",
    failed: "Saltix Connect сейчас не может связаться с сетью.",
    retry: "Попробовать снова",
    changesIn: "Код обновится через {time}",
    close: "Закрыть",
    note: "Прежде чем продолжить, Saltix покажет этот сайт и то, что он получит. Ничего секретного не покидает телефон.",
    qr: "QR-код для Saltix",
  },
} as const satisfies Record<Lang, Record<string, string>>;
