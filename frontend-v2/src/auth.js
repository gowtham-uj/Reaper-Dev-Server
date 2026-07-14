import { createSignal } from "solid-js";

// A successful sign-in changes the browser cookie and this in-memory view together.
// Route transitions can therefore render the authenticated shell without remounting.
export const [currentUser, setCurrentUser] = createSignal(null);
