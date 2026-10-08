import { useEffect, useState } from "react";

export default function Booting({ label }: { label: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 300);
    return () => clearTimeout(timer);
  }, []);
  return <div className="booting" role="status">{slow ? label : null}</div>;
}
