import { useEffect, useState } from "react";

/** A wait that says what it waits for, only once it is long enough to notice. */
export default function Booting({ label }: { label: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 300);
    return () => clearTimeout(timer);
  }, []);
  return <div className="booting" role="status">{slow ? label : null}</div>;
}
