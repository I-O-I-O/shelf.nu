import { redirect, type LoaderFunctionArgs } from "react-router";

export function loader({ context, request }: LoaderFunctionArgs) {
  void context;
  void request;
  throw redirect("/ioio");
}
