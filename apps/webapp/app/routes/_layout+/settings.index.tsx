import { redirect } from "react-router";

export function loader() {
  return redirect("lab-information");
}

export const shouldRevalidate = () => false;
