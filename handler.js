import { ConfigWrapper, Events, Profiles, FilterBuilder } from "klaviyo-api";
import { object, string, number, boolean, array, mixed } from 'yup';


/**
 * This endpoint will receive events from WEB and APP and pass them to
 * Klaviyo.
 * 
 * Retry Logic: The `ConfigWrapper` from Klaviyo comes with default retry logic.
 * @see https://github.com/klaviyo/klaviyo-api-node?tab=readme-ov-file#retry-options
 */
export default async (req, res) => {

    if (!process.env["KLAVIYO_PRIVATE_API_KEY"]) {
        throw new Error(
            "KLAVIYO_PRIVATE_API_KEY with events:read permissions must be set as an environment variable"
        );
    }

    let data, responseData;

    try {
        const result = await requestBodySchema.validate(req.body);

        data = result;
    } catch (e) {
        console.log(e);
        const errorObject = {
            message: `PROD: ` + e.errors + `\n`,
            dt: Math.floor(Date.now() / 1000)
        }

        // Send to BetterStack 
        const ingestingHost = "s1289345.eu-nbg-2.betterstackdata.com";
        const sourceToken = "xxxxxxxxxx";

        const url = `https://${ingestingHost}`;

        await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${sourceToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(errorObject)
        })

        // Log
        console.error(JSON.stringify(errorObject, null, 2))

        return res.json(errorObject).status(200);
    }



    ConfigWrapper(process.env["KLAVIYO_PRIVATE_API_KEY"]);


    /**
     * Create or Update Membership or Package Data Records
     */
    await createAndUpdateMemberhipOrPackageRecords(data);

    switch (data.action) {
        case 'profile.created': {
            const {
                first_name,
                last_name,
                address_line1,
                birth_date,
                city,
                country,
                email,
                postal_code,
                is_opted_in_to_marketing,
                is_opted_in_to_sms,
                home_location,
                phone_number
            } = data.profile;

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: data.action,
                                    },
                                },
                            },
                            properties: {
                                email: email,
                            },
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        firstName: first_name,
                                        lastName: last_name,
                                        email: email,
                                        location: {
                                            country: country,
                                            address1: address_line1,
                                            city: city,
                                            zip: postal_code,
                                        },
                                        properties: {
                                            dob: birth_date,
                                            preferred_club: home_location.name,
                                        },
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            const subscriptions = {};

            if (is_opted_in_to_marketing == true) {
                subscriptions.email = {
                    marketing: {
                        consent: 'SUBSCRIBED',
                    },
                };
            }

            if (is_opted_in_to_sms == true) {
                subscriptions.sms = {
                    marketing: {
                        consent: 'SUBSCRIBED',
                    },
                };
            }

            try {
                await Profiles.bulkSubscribeProfiles({
                    data: {
                        type: 'profile-subscription-bulk-create-job',
                        attributes: {
                            profiles: {
                                data: [
                                    {
                                        type: 'profile',
                                        attributes: {
                                            email: email,
                                            phoneNumber: subscriptions.sms ? phone_number : null,
                                            subscriptions,
                                            
                                        },
                                    },
                                ],
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: 'profile.created',
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case 'profile.get_user_info': {
            const email = data.customer?.email || data.custom_data?.customer?.email;

            if (!email || typeof email !== 'string') {
                return res.status(400).json({
                    event_name: data.action,
                    message: 'Email parameter is missing or invalid',
                });
            }

            try {
                const filter = new FilterBuilder().equals('email', email).build();
                const response = await Profiles.getProfiles({
                    filter,
                    additionalFieldsProfile: ['subscriptions'],
                });
                const profiles = response.body.data;

                if (!profiles || profiles.length === 0) {
                    responseData = { profile_found: false };
                } else {
                    responseData = formatKlaviyoProfile(profiles[0]);
                }
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data?.errors || e.body?.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                return res.status(200).json(errorObject);
            }

            break;
        }

        case 'reservation.created': {
            // Handle booked_class event

            const reservation = data.reservation;
            const class_session = reservation.class_session;

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: data.action,
                                    },
                                },
                            },
                            properties: {
                                class_name: class_session.class_name,
                                class_type: class_session.class_type.name,
                                class_date_time: class_session.start_datetime,
                                trainer_name: class_session.instructors[0].name,
                                club: class_session.location.name,
                                is_booked_for_guest: reservation.guest_email ? true : false,
                                membership_used:
                                    reservation.membership_payments[0]?.contract_name,
                                package_used: reservation.credit_payments[0]?.package_name,
                                reservation_type: reservation.reservation_type,
                                spot_type: reservation.spot,
                                guest_email: reservation.guest_email,
                                reservation_id: reservation.id,
                                class_session_id: class_session.id,
                            },
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: data.reservation.customer.email,
                                    },
                                },
                            },
                        },
                    },
                });

            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case 'reservation.checkedin': {
            // Handle attended_class event
            const reservation = data.reservation;
            const class_session = reservation.class_session;
            const membership_payment = reservation.membership_payments[0];
            const credit_payment = reservation.credit_payments[0];

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: data.action,
                                    },
                                },
                            },
                            properties: {
                                class_name: class_session.class_name,
                                class_type: class_session.class_type.name,
                                class_date_time: class_session.start_datetime,
                                trainer_name: class_session.instructors[0].name,
                                club: class_session.location.name,
                                reservation_id: reservation.id,
                                class_session_id: reservation.class_session.id,
                                package_name: credit_payment ? credit_payment.package_name : undefined,
                                membership_name: membership_payment ? membership_payment.name : undefined
                            },
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: reservation.customer.email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case 'reservation.cancelled': {
            // Handle class_cancelled event
            const reservation = data.reservation;
            const class_session = reservation.class_session;

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: data.action,
                                    },
                                },
                            },
                            properties: {
                                class_name: class_session.class_name,
                                class_type: class_session.class_type.name,
                                class_date_time: class_session.start_datetime,
                                trainer_name: class_session.instructors[0].name,
                                club: class_session.location.name,
                                reservation_id: reservation.id,
                                class_session_id: class_session.id,
                            },
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: data.reservation.customer.email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case 'reservation.noshowed': {
            // Handle class_no_show event
            const reservation = data.reservation;
            const class_session = reservation.class_session;

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: data.action,
                                    },
                                },
                            },
                            properties: {
                                class_name: class_session.class_name,
                                class_type: class_session.class_type.name,
                                class_date_time: class_session.start_datetime,
                                trainer_name: class_session.instructors[0].name,
                                club: class_session.location.name,
                                reservation_id: reservation.id,
                                class_session_id: class_session.id,
                            },
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: data.reservation.customer.email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case 'membership.purchased': {
            // Handle membership_purchased event
            const membership = data.membership;


            if (
                'membership_contract_id' in membership === false ||
                'order' in membership === false ||
                'start_type' in membership === false
            ) {
                return res.json({ error: 'Invalid `Membership` Payload' }).status(200);
            }

            const orderData = await marianaTekFetcher("orders/" + membership.order.id);

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: data.action,
                                    },
                                },
                            },
                            properties: {
                                id: membership.membership_contract_id,
                                name: membership.name,
                                start_date: membership.start_date,
                                end_date: membership.end_date,
                                purchase_date: membership.purchase_date,
                                start_type: membership.start_type,
                            },
                            value: membership.order.total,
                            value_currency: orderData?.data.attributes.currency,
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: data.membership.customer.email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case 'membership.deactivated': {
            // Handle membership_cancelled event
            const membership = data.membership;

            const membershipInstance = await marianaTekFetcher("membership_instances/" + membership.id);

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: data.action,
                                    },
                                },
                            },
                            properties: {
                                name: membership.name,
                                start_date: membership.start_date,
                                end_date: membership.end_date,
                                id: membership.id,
                                cancellation_reason: membershipInstance?.data.attributes.cancellation_reason
                            },
                            value: membershipInstance?.data.attributes.renewal_rate,
                            value_currency: membershipInstance?.data.attributes.renewal_currency,
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: data.membership.customer.email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;
        }

        case 'order.completed': {
            const isRefund = data.order.refund_sources.length > 0;
            const product = data.order.order_lines[0].product;
            const productType = product.product_type;

            if (isRefund || productType !== 'Credits') {
                break;
            }

            const packageData = await marianaTekFetcher("packages/" + product.id);
            const { expiration_interval, expiration_interval_length } = packageData?.data?.attributes ?? {};
            let orderDatetime = data.order.order_datetime;
            let expiryDate = null;

            if (
                ['DY', 'WK', 'MO', 'YR'].includes(expiration_interval) &&
                Number.isInteger(expiration_interval_length) &&
                expiration_interval_length >= 0
            ) {
                const date = new Date(orderDatetime);

                if (!Number.isNaN(date.getTime())) {
                    if (expiration_interval === 'DY' || expiration_interval === 'WK') {
                        const days = expiration_interval_length * (expiration_interval === 'WK' ? 7 : 1);
                        date.setUTCDate(date.getUTCDate() + days);
                    } else {
                        // Clamp month/year additions to the last day of the target month.
                        const originalDay = date.getUTCDate();
                        const months = expiration_interval_length * (expiration_interval === 'YR' ? 12 : 1);
                        date.setUTCDate(1);
                        date.setUTCMonth(date.getUTCMonth() + months);
                        const lastDay = new Date(date.getTime());
                        lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
                        date.setUTCDate(Math.min(originalDay, lastDay.getUTCDate()));
                    }

                    if (!Number.isNaN(date.getTime())) {
                        expiryDate = date;
                    }
                }
            }

            const orderLine = data.order.order_lines[0];

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: 'package.purchased',
                                    },
                                },
                            },
                            properties: {
                                name: orderLine.product.name,
                                price: orderLine.line_total,
                                id: orderLine.product.id,
                                expiryDate,
                            },
                            value: orderLine.line_total,
                            valueCurrency: data.order.currency,
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: data.order.customer.email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;

        }

        case "order.preordered_product": {
            const product = data.pre_ordered_product;

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: 'order.preordered_product',
                                    },
                                },
                            },
                            properties: {
                                id: product.id,
                                name: product.name,
                            },
                            value: product.value,
                            valueCurrency: product.value_currency,
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: product.customer.email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;


        }

        case "order.completed_preorder": {

            const {
                product_name,
                product_id,
                class_name,
                trainer_name,
                club,
                discount_amount,
                discount_code,
                reservation_id,
                value,
                value_currency,
                customer
            } = data.pre_order_data;

            try {
                await Events.createEvent({
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: {
                                        name: 'order.completed_preorder',
                                    },
                                },
                            },
                            properties: {
                                product_name: product_name,
                                product_id: product_id,
                                class_name: class_name,
                                trainer_name: trainer_name,
                                club: club,
                                discount_amount: discount_amount,
                                discount_code: discount_code,
                                reservation_id: reservation_id,
                            },
                            value: value,
                            valueCurrency: value_currency,
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: {
                                        email: customer.email,
                                    },
                                },
                            },
                        },
                    },
                });
            } catch (e) {
                const errorObject = {
                    event_name: data.action,
                    message: e.message,
                    errors: e.response?.data.errors,
                };

                console.error(JSON.stringify(errorObject, null, 2));

                // @ts-expect-error - This is a valid response
                return res.json(errorObject).status(200);
            }

            break;


        }

        default:
            throw new Error('Unsupported Event');
    }

    res.json({ success: true, data: responseData }).status(200);
};

/**
 * Fetches data from the Mariana Tek API.
 *
 * @async
 * @function marianaTekFetcher
 * @param {string} path - The API endpoint path to append to the base URL.
 * @returns {Promise<Object|null>} The parsed JSON response if successful, otherwise `null`.
 *
 * @throws {Error} Logs an error if the request fails or if JSON parsing encounters an issue.
 */
async function marianaTekFetcher(path) {

    try {
        const response = await fetch(process.env.MT_API_ENDPOINT + path, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.MT_ADMIN_TOKEN}`,
            }
        });

        if (!response.ok) {
            console.error("Failed to fetch MT data => ", response.status);
            return null;
        }


        return await response.json();
    } catch (e) {
        console.log("Failed to parse MT response => ", e)

        return null;
    }

}

function formatKlaviyoProfile(rawProfile) {
    const attributes = rawProfile.attributes || {};
    const rawSub = attributes.subscriptions || {};

    const mapSubChannel = (channelData, canReceiveKey) => {
        if (!channelData || !channelData.consent || channelData.consent === 'NEVER_SUBSCRIBED') {
            return null;
        }
        return {
            consent: channelData.consent,
            can_receive: channelData[canReceiveKey] ?? false,
        };
    };

    return {
        profile_found: true,
        profile: {
            id: rawProfile.id,
            external_id: attributes.external_id || null,
            email: attributes.email || null,
            phone_number: attributes.phone_number || null,
        },
        subscriptions: {
            email: {
                marketing: mapSubChannel(rawSub.email?.marketing, 'canReceiveEmailMarketing'),
            },
            sms: {
                marketing: mapSubChannel(rawSub.sms?.marketing, 'canReceiveSmsMarketing'),
                transactional: mapSubChannel(rawSub.sms?.transactional, 'canReceiveSmsTransactional'),
            },
            whatsapp: {
                marketing: rawSub.whatsapp?.marketing ? {
                    consent: rawSub.whatsapp.marketing.consent,
                    can_receive: rawSub.whatsapp.marketing.canReceive ?? false,
                    phone_number: rawSub.whatsapp.marketing.phoneNumber || attributes.phone_number || null,
                } : null,
                transactional: rawSub.whatsapp?.transactional || null,
                conversational: rawSub.whatsapp?.conversational || null,
            },
        },
        properties: attributes.properties || {},
    };
}

/**
 * This is a temporary workaround to create custom objects in Klaviyo. 
 * Once the package in NapkinIO is updated we will not need this anymmore.
 */
async function createAndUpdateMemberhipOrPackageRecords(data) {
    let user_id = "";
    let user_email = "";

    /**
     * Extract User ID and User Email
     */
    switch (data.action) {
        case 'profile.created': {
            user_id = data.profile.id;
            user_email = data.profile.email;

            break;
        }
        case "profile.get_user_info": {

            break;
        }
        case "reservation.created": {
            user_id = data.reservation.customer.id;
            user_email = data.reservation.customer.email;

            break;
        }
        case "reservation.checkedin": {
            user_id = data.reservation.customer.id;
            user_email = data.reservation.customer.email;

            break;
        }
        case "reservation.cancelled": {
            user_id = data.reservation.customer.id;
            user_email = data.reservation.customer.email;

            break;
        }
        case "reservation.noshowed": {
            user_id = data.reservation.customer.id;
            user_email = data.reservation.customer.email;

            break;
        }
        case "membership.purchased": {
            user_id = data.membership.customer.id;
            user_email = data.membership.customer.email;

            break;
        }
        case "membership.deactivated": {
            user_id = data.membership.customer.id;
            user_email = data.membership.customer.email;

            break;
        }
        case "order.completed": {
            user_id = data.order.customer.id;
            user_email = data.order.customer.email;

            break;
        }
        case "order.preordered_product": {

            break;
        }
        case "order.completed_preorder": {

            break;
        }
    }

    if (!user_id || !user_email) {
        console.log("Failed to find user id/email => ", data.action);
    }

    /**
     * Fetch membership instances and credit transactions data from MT
     */
    const allMembershipsResults = await marianaTekFetcher(
        `membership_instances?user=${user_id}`
    );

    const allPackagesResults = await marianaTekFetcher(
        `credit_transactions?user=${user_id}&page_size=100`
    );

    /**
     * Parse MT data to generate appropriate object for Klaviyo
     */
    const membershipObjects =
        allMembershipsResults?.data.map(({ id, attributes }) => ({
            type: "data-source-record",
            attributes: {
                record: {
                    type: "membership",
                    id: id,
                    name: attributes.membership_name,
                    status: attributes.status,
                    startDate: attributes.start_date
                        ? new Date(attributes.start_date)
                        : null,
                    endDate: attributes.end_date ? new Date(attributes.end_date) : null,
                    email: user_email,
                }

            }
        })) || [];

    const packageObjects =
        allPackagesResults?.data.map(({ id, attributes }) => ({
            type: "data-source-record",
            attributes: {
                record: {
                    type: "package",
                    id: id,
                    name: attributes.credit_name,
                    status: attributes.is_expired ? "expired" : "active",
                    startDate: attributes.transaction_datetime
                        ? new Date(attributes.transaction_datetime)
                        : null,
                    endDate: attributes.expiration_datetime
                        ? new Date(attributes.expiration_datetime)
                        : null,
                    email: user_email,
                }
            }
        })) || [];

    const dataSourceRecords = {
        data: {
            type: "data-source-record-bulk-create-job",
            attributes: {
                "data-source-records": {
                    data: [
                        ...membershipObjects,
                        ...packageObjects
                    ]
                }
            },
            relationships: {
                "data-source": {
                    data: {
                        type: "data-source",
                        id: "01K1G5JPFAVHJ5BP1SWEEE82RH"
                    }
                }
            }
        }
    };

    const options = {
        method: 'POST',
        headers: {
            accept: 'application/vnd.api+json',
            revision: '2026-07-15',
            'content-type': 'application/vnd.api+json',
            Authorization: `Klaviyo-API-Key ${process.env["KLAVIYO_PRIVATE_API_KEY"]}`
        },
        body: JSON.stringify(dataSourceRecords)
    };

    const res = await fetch('https://a.klaviyo.com/api/data-source-record-bulk-create-jobs', options);

    const status = await res.status;

    if (status !== 204) {
        console.error("Failed to update data source", await res.json())
    }



}


/**
 * The following code contains yup object definitions to validate our payloads
 */
const profileSchema = object({
    id: string().required(),
    address_line1: string().nullable(),
    birth_date: string().nullable(),
    city: string().nullable(),
    country: string().nullable(),
    email: string().email().nullable(),
    first_name: string().required(),
    full_name: string().required(),
    gender: string().nullable(),
    home_location: object({
        id: string().required(),
        type: string().required(),
        name: string().required(),
        timezone: string().required(),
        region: object({
            id: string().required(),
            type: string().required(),
            name: string().required(),
        }).required(),
    }).required(),
    is_opted_in_to_marketing: boolean().required(),
    is_opted_in_to_sms: boolean().required(),
    last_name: string().required(),
    phone_number: string().nullable(),
    postal_code: string().nullable(),
});

const classSessionSchema = object({
    id: number().required(),
    type: string().required(),
    cancellation_datetime: string().nullable(),
    class_type: object({
        id: number().required(),
        type: string().required(),
        duration: number().required(),
        is_live_stream: boolean(),
        name: string().required(),
    }).required(),
    class_name: string().required(),
    end_datetime: string().required(),
    instructors: array()
        .of(
            object({
                id: number().required(),
                type: string().required(),
                name: string().required(),
            }).required()
        )
        .nullable(),
    location: object({
        id: string().required(),
        type: string().required(),
        name: string().required(),
        timezone: string().required(),
        region: object({
            id: string().required(),
            type: string().required(),
            name: string().required(),
        }).required(),
    }).required(),
    start_date: string().required(),
    start_datetime: string().required(),
    start_time: string().required(),
});

const creditPaymentsSchema = array().of(
    object({
        expiration_date: string(),
        is_expired: boolean().required(),
        name: string().required(),
        package_name: string().required(),
        package_source: string().nullable(),
        remaining: number().nullable(),
    }).required()
);

const membershipPaymentsSchema = array().of(
    object({
        end_date: string().nullable(),
        name: string().required(),
        remaining_renewals: string().nullable(),
    }).required()
);

const reservationSchema = object({
    id: number().required(),
    type: string().required(),
    class_session: classSessionSchema,
    credit_payments: creditPaymentsSchema,
    membership_payments: membershipPaymentsSchema,
    customer: profileSchema,
    guest_email: string().nullable(),
    payer: profileSchema,
    reservation_type: string().required(),
    spot: object({
        id: string(),
        type: string(),
        name: string(),
    }).nullable(),
    status: string().required(),
});

const orderSchema = object({
    id: number(),
    type: string(),
    currency: string(),
    customer: profileSchema,
    discount_total: number(),
    discounts: array().of(
        object({
            name: string(),
            amount: number(),
        })
    ),
    location: object({
        id: string().required(),
        type: string().required(),
        name: string().required(),
        timezone: string().required(),
        region: object({
            id: string().required(),
            type: string().required(),
            name: string().required(),
        }).required(),
    }).required(),
    number: string(),
    order_datetime: string(),
    order_lines: array().of(
        object({
            id: number(),
            type: string(),
            line_subtotal: number(),
            line_total: number(),
            options: array()
                .of(
                    object({
                        name: string().required(),
                        value: string().required(),
                    })
                )
                .nullable(),
            product: object({
                id: number().required(),
                type: string().required(),
                name: string().required(),
                product_type: string().required(),
            }).required(),
            quantity: number().required(),
            status: string().required(),
            unit_subtotal: number().required(),
            unit_total: number().required(),
        })
    ),
    payment_sources: array()
        .of(
            object({
                name: string(),
                amount: number(),
                bankcard_id: string().nullable(),
            })
        )
        .nullable(),
    refund_sources: array()
        .of(
            object({
                name: string(),
                amount: number(),
                bankcard_id: string().nullable(),
            })
        )
        .nullable(),
    status: string(),
    subtotal: number(),
    total: number().required(),
});

const membershipOrderSchema = object({
    id: number(),
    number: string(),
    order_datetime: string(),
    payment_sources: array()
        .of(
            object({
                name: string().required(),
                amount: number().required(),
                bankcard_id: string().nullable(),
            }).required()
        )
        .nullable(),
    purchase_source: string().nullable(),
    status: string(),
    subtotal: number(),
    total: number(),
});

const membershipSchema = object({
    id: number().required(),
    type: string().required(),
    customer: profileSchema.required(),
    end_date: string().nullable(),

    name: string().required(),
    purchase_date: string().required(),
    purchase_location: string().required(),
    start_date: string().nullable(),
    status: string().required(),

    // These are not availble in `membership.purchased`
    freeze_start_date: string().nullable(),
    freeze_end_date: string().nullable(),

    // These are only available if the action is `memberhip.purchased`
    billing_type: string().nullable(),
    purchase_location_id: string(),
    membership_contract_id: string(),
    order: membershipOrderSchema,
    start_type: string(),
});

const preOrderedProduct = object({
    id: string().required(),
    name: string().required(),
    value: string().required(),
    value_currency: string().required(),
    customer: object({
        email: string().email().nullable(),
    }).required()
})

const preOrderData = object({
    product_name: string().required(),
    product_id: string().required(),
    class_name: string().required(),
    class_date: string().required(),
    trainer_name: string(),
    club: string().required(),
    discount_amount: number(),
    discount_code: string(),
    reservation_id: string().required(),
    value: number().required(),
    value_currency: string().required(),
    customer: object({
        email: string().email().nullable(),
    }).required()
})

const customData = object({
    customer: object({
        email: string().email().nullable(),
    }).required()
})


const requestBodySchema = object({
    action: mixed()
        .oneOf([
            'profile.created',
            "profile.get_user_info",
            'reservation.created',
            'reservation.checkedin',
            'reservation.cancelled',
            'reservation.noshowed',
            'membership.purchased',
            'membership.deactivated',
            'order.completed',
            'order.completed_preorder',
            'order.preordered_product'
        ])
        .required()
        .typeError('Action is required'),
    tenant: string().required(),
    event_datetime: string().required(),
    profile: profileSchema.when('action', (action, schema) => {
        if (typeof action !== 'string') {
            throw new Error('Invalid action');
        }

        if (action === 'profile.created') {
            return schema.required();
        } else {
            return schema.strip();
        }
    }),
    reservation: reservationSchema.when('action', (action, schema) => {
        if (typeof action !== 'string') {
            throw new Error('Invalid action');
        }

        if (
            [
                'reservation.created',
                'reservation.checkedin',
                'reservation.cancelled',
                'reservation.noshowed',
            ].includes(action)
        ) {
            return schema.required();
        } else {
            return schema.strip();
        }
    }),
    membership: membershipSchema.when('action', (action, schema) => {
        if (typeof action !== 'string') {
            throw new Error('Invalid action');
        }

        if (['membership.purchased', 'membership.deactivated'].includes(action)) {
            return schema.required();
        } else {
            return schema.strip();
        }
    }),
    order: orderSchema.when('action', (action, schema) => {
        if (typeof action !== 'string') {
            throw new Error('Invalid action');
        }

        if (action === 'order.completed') {
            return schema.required();
        } else {
            return schema.strip();
        }
    }),
    pre_ordered_product: preOrderedProduct.when('action', (action, schema) => {
        if (typeof action !== 'string') {
            throw new Error('Invalid action');
        }

        if (action === 'order.preordered_product') {
            return schema.required();
        } else {
            return schema.strip();
        }
    }),
    pre_order_data: preOrderData.when('action', (action, schema) => {
        if (typeof action !== 'string') {
            throw new Error('Invalid action');
        }

        if (action === 'order.completed_preorder') {
            return schema.required();
        } else {
            return schema.strip();
        }
    }),
    custom_data: customData.when('action', (action, schema) => {
        if (typeof action !== 'string') {
            throw new Error('Invalid action');
        }

        if (
            [
                'profile.get_user_info',
            ].includes(action)
        ) {
            return schema.required();
        } else {
            return schema.strip();
        }
    }),
});
