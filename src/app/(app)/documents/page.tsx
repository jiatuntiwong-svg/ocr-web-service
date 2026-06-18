"use client";
import DocumentsView from "@/components/DocumentsView";
import { useApp } from "@/lib/contexts/AppContext";

export default function DocumentsPage() {
    const { user } = useApp();
    return <DocumentsView userId={user?.id || ""} />;
}
