async function test() {
  try {
    const res = await fetch("http://127.0.0.1:5000/api/public/demo/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Rahul Sharma",
        phoneNumber: "+919627152414",
        scenarioId: "car_dealership",
        language: "Hindi",
      }),
    });

    const status = res.status;
    const body = await res.text();
    console.log("STATUS:", status);
    console.log("RESPONSE_BODY:", body);
  } catch (e) {
    console.error("FETCH_ERROR:", e);
  }
}

test();
