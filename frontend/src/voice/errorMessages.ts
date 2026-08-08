import { VoiceApiError } from '../api/voiceApi';

export function voiceErrorMessage(error: unknown): string {
  if (error instanceof VoiceApiError) {
    switch (error.code) {
      case 'invalid-invite':
        return 'Invalid or expired invite.';
      case 'backend-unavailable':
        return 'The voice service is unavailable. Try again.';
      case 'invalid-response':
        return 'The voice service returned an invalid response.';
    }
  }

  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Microphone access was denied. Allow access in your browser and try again.';
  }

  return 'Could not connect to the voice room. Try again.';
}
