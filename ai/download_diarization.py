"""Explicit model download only. No recording is sent to Hugging Face."""
import getpass
from pathlib import Path


def main():
    from huggingface_hub import snapshot_download
    destination = Path(__file__).resolve().parent.parent / 'models' / 'diarization'
    token = getpass.getpass('Hugging Face read token (hidden): ')
    snapshot_download('pyannote/speaker-diarization-community-1', token=token,
                      local_dir=str(destination))
    print(f'Model saved: {destination}')


if __name__ == '__main__':
    main()
