export type KeyboardState = {
  isOpen: boolean;
  height: number;
};

type KeyboardCallback = (state: KeyboardState) => void;

const KEYBOARD_THRESHOLD = 150;

export function observeVirtualKeyboard(callback: KeyboardCallback): () => void {
  const vv = window.visualViewport;
  if (!vv) {
    return () => {};
  }

  let wasOpen = false;

  const check = () => {
    const heightDiff = window.innerHeight - vv.height;
    const isOpen = heightDiff > KEYBOARD_THRESHOLD;

    if (isOpen !== wasOpen) {
      wasOpen = isOpen;
      callback({ isOpen, height: isOpen ? heightDiff : 0 });
    }
  };

  vv.addEventListener("resize", check);
  vv.addEventListener("scroll", check);

  return () => {
    vv.removeEventListener("resize", check);
    vv.removeEventListener("scroll", check);
  };
}
