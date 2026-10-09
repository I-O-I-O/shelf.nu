import { redirect } from "react-router";

export function loader() {
  return redirect("backup");
}

export const shouldRevalidate = () => false;
