import { redirect } from "next/navigation";

// Root simply forwards to /dashboard. The (app)/layout handles auth — if the
// user isn't signed in, useAuth there bounces them to /login.
export default function Root() {
    redirect("/dashboard");
}
