const express = require("express");
const bodyParser = require("body-parser");
const { sequelize, Op } = require("./model");
const { getProfile } = require("./middleware/getProfile");
const app = express();
app.use(bodyParser.json());
app.set("sequelize", sequelize);
app.set("models", sequelize.models);

/**
 * FIX ME!
 * @returns contract by id
 */
app.get("/contracts/:id", getProfile, async (req, res) => {
    const { Contract } = req.app.get("models");
    const { id } = req.params;
    const contract = await Contract.findOne({
        where: {
            id,
            [Op.or]: [{ ContractorId: id }, { ClientId: id }],
        },
    });
    if (!contract) {
        return res.status(404).end();
    }
    res.json(contract);
});

/**
 * @returns list of contracts for the user(Contractor or Client)
 */
app.get("/contracts", getProfile, async (req, res) => {
    const { Contract } = req.app.get("models");
    const { id } = req.profile;
    const contracts = await Contract.findAll({
        where: {
            status: { [Op.not]: "terminated" },
            [Op.or]: [{ ContractorId: id }, { ClientId: id }],
        },
    });
    if (contracts.length === 0) {
        return res.status(200).json("No Contracts found").end();
    }
    res.json(contracts);
});

const getUnPaidJobs = async ({ id, Job, Contract }) => {
    const uppaidContractsWithJobs = await Contract.findAll({
        attributes: [],
        raw: true,
        nest: true,
        where: {
            status: "in_progress",
            [Op.or]: [{ ContractorId: id }, { ClientId: id }],
        },
        include: {
            model: Job,
            attributes: [["id", "JobId"], "Price"],
            where: {
                paid: { [Op.is]: null },
            },
        },
    });

    return uppaidContractsWithJobs.map(({ Jobs }) => Jobs).flat();
};

/**
 * @returns list of unpaid jobs
 */
app.get("/jobs/unpaid", getProfile, async (req, res) => {
    const { id } = req.profile;
    const { Job, Contract } = req.app.get("models");
    const unpaidJobs = await getUnPaidJobs({ Job, Contract, id });

    if (unpaidJobs.length === 0) {
        return res.status(200).json("No Unpaid Jobs found").end();
    }
    res.json(unpaidJobs);
});

/**
 * @returns Pay for the Job
 */
app.post("/jobs/:job_id/pay", getProfile, async (req, res) => {
    const { Job } = req.app.get("models");
    const { job_id } = req.params;

    const job = await Job.findOne({
        where: {
            id: job_id,
        },
    });

    const contract = await job.getContract();

    const client = await contract.getClient();
    const contractor = await contract.getContractor();

    if (job.paid === 1) {
        return res.status(200).json("Job has been paid already").end();
    }

    if (client.balance < job.price) {
        return res.status(200).json("Not enough balance to pay the job").end();
    }

    try {
        const result = await sequelize.transaction(async () => {
            await Promise.all([
                client.update({ balance: client.balance - job.price }),
                contractor.update({ balance: contractor.balance + job.price }),
                job.update({ paid: 1 }),
            ]);

            return "Update Successful";
        });

        res.send(result);
    } catch (err) {
        res.send(err.message);
    }
});

/**
 * @returns Deposit amount
 */
app.post("/balances/deposit/:userId", getProfile, async (req, res) => {
    const { userId } = req.params;
    const { amount } = req.body;
    const { Job, Contract, Profile } = req.app.get("models");

    const user = await Profile.findOne({ where: { id: userId } });

    if (user.type === "contractor") {
        return res.status(200).json("User is a contractor").end();
    }

    const unPaidJobs = await getUnPaidJobs({ Job, Contract, id: userId });
    const totalUnPaidAmount = unPaidJobs.reduce((acc, job) => acc + job.Price, 0);

    if (amount > totalUnPaidAmount / 4) {
        return res
            .status(200)
            .json("Can't deposit more than 25% of unpaid jobs")
            .end();
    }

    await user.update({ balance: user.balance + amount });

    res.send("Client balance updated");
});

/**
 * @returns Best Paid contractor profession
 */
app.get("/admin/best-profession", getProfile, async (req, res) => {
    // There is a doubt how to filter the results based on query period which are received as req.query
    // Is it the Job payment date that need to fall between the below or Contract start/end date
    // Model has no Contract Start and EndDate suggesting the period where a Contractor worked 

    const startDate = req.query.start;
    const endDate = req.query.end;


    const [results] = await sequelize.query(`SELECT sumQuery.Contractor, sumQuery.Profession, MAX(TotalJobsPaidAmount) AS AmountPaid 
    FROM 
    ( 
      SELECT firstName || ' ' || lastName as Contractor,Profession, SUM(Jobs.price) as TotalJobsPaidAmount 
      FROM Profiles
      INNER JOIN Contracts
      ON Profiles.id = Contracts.ContractorId
      INNER JOIN Jobs
      ON Contracts.id = Jobs.ContractId AND Jobs.paid = 1
      GROUP BY ContractorId
    ) AS sumQuery`);

    res.json(results);
});

/**
 * @returns Best Paid client with profession
 */
app.get("/admin/best-clients", getProfile, async (req, res) => {
    const startDate = req.query.start;
    const endDate = req.query.end;


    const [results] = await sequelize.query(`SELECT Client, Profession, MAX(TotalJobsPaidAmount) AS AmountPaid 
    FROM 
    ( 
      SELECT firstName || ' ' || lastName as Client,Profession, SUM(Jobs.price) as TotalJobsPaidAmount 
      FROM Profiles
      INNER JOIN Contracts
      ON Profiles.id = Contracts.ClientId
      INNER JOIN Jobs
      ON Contracts.id = Jobs.ContractId AND Jobs.paid = 1
      GROUP BY ClientId
    ) AS sumQuery`);

    res.json(results);
});

module.exports = app;
